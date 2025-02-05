//     express-cdn
//     Copyright (c) 2012- Nick Baugh <niftylettuce@gmail.com> (http://niftylettuce.com)
//     MIT Licensed

// Node.js module for delivering optimized, minified, mangled, gzipped,
//  and CDN-hosted assets in Express using S3 and CloudFront.

// * Author: [@niftylettuce](https://twitter.com/#!/niftylettuce)
// * Source: <https://github.com/niftylettuce/express-cdn>

// # express-cdn

var fs = require('fs'),
  url = require('url'),
  path = require('path'),
  mime = require('mime'),
  knox = require('knox'),
  walk = require('walk'),
  zlib = require('zlib'),
  async = require('async'),
  request = require('request'),
  _ = require('underscore'),
  uglify = require('uglify-js'),
  spawn = require('child_process').spawn,
  optipngPath = require('optipng-bin'),
  jpegtranPath = require('jpegtran-bin'),
  cleanCSS = require('clean-css'),
  retry = require('retry'),
  aws = require('aws-sdk');

_.str = require('underscore.string');
_.mixin(_.str.exports());

var throwError = function(msg) {
  throw new Error('CDN: ' + msg);
};

var logger = function(msg, ...args) {
  console.log(msg, ...args);
};

// `escape` function from Lo-Dash v0.2.2 <http://lodash.com>
// and Copyright 2012 John-David Dalton <http://allyoucanleet.com/>
// MIT licensed <http://lodash.com/license>
var escape = function(string) {
  return (string + '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

var renderAttributes = function(attributes) {
  var str = [];
  for (var name in attributes) {
    if (_.has(attributes, name)) {
      str.push(escape(name) + '="' + escape(attributes[name]) + '"');
    }
  }
  return str.sort().join(" ");
};

var handleSrcAttr = function(attributes) {
  return attributes['data-src'] ? 'data-src' : 'src';
}

var createTag = function(src, asset, attributes, version) {
  var processedSrc = handleSrcAttr(attributes);
  // Cachebusting
  version = version || '';
  // Enable "raw" output
  if ('raw' in attributes && attributes.raw === true) {
    return src + asset + version;
  }
  // Check mime type
  switch (mime.getType(asset.split('?')[0])) {
    case 'application/javascript':
    case 'text/javascript':
      attributes.type = attributes.type || 'text/javascript';
      attributes.src = src + asset + version;
      return '<script ' + renderAttributes(attributes) + '></script>';
    case 'text/css':
      attributes.rel = attributes.rel || 'stylesheet';
      attributes.href = src + asset + version;
      return '<link ' + renderAttributes(attributes) + ' />';
    case 'image/png':
    case 'image/jpg':
    case 'image/jpeg':
    case 'image/pjpeg':
    case 'image/gif':
    case 'image/svg+xml':
      attributes[processedSrc] = src + asset + version;
      return '<img ' + renderAttributes(attributes) + ' />';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      attributes.rel = attributes.rel || 'shortcut icon';
      attributes.href = src + asset + version;
      return '<link ' + renderAttributes(attributes) + ' />';
    default:
      throwError('unknown asset type');
  }
};

/**
 * @param {import('../index').CdnOptions} options
 */
var renderTag = function(options, assets, attributes) {
  // Set attributes
  attributes = attributes || {};
  // In production mode, check for SSL
  var src = '', position,
    timestamp = 0;
  if (options.production) {
    if (options.ssl === 'relative') {
      src = '//' + options.domain;
    } else if (options.ssl) {
      src = 'https://' + options.domain;
    } else {
      src = 'http://' + options.domain;
    }

    if (options.prefix && options.appendPrefix !== false) {
      const { prefix } = options;
      src = (new URL(prefix, src)).toString();
    }

    // Process array by breaking file names into parts
    //  and check that array mime types are all equivalent
    if (typeof assets === 'object') {
      var concat = [],
        type = '';
      for (var b = 0; b < assets.length; b += 1) {
        if (type === '')
          type = mime.getType(assets[b]);else if (mime.getType(assets[b]) !== type)
          throwError('mime types in CDN array of assets must all be the same');
        // Push just the file name to the concat array
        concat.push(path.basename(assets[b]));
        timestamp = Math.max(timestamp, fs.statSync(path.join(options.publicDir, assets[b])).mtime.getTime());
      }
      var name = encodeURIComponent(concat.join("+"));
      position = name.lastIndexOf('.');
      //name = _(name).splice(position, 0, '.' + timestamp);
      name = name + '?cache=' + timestamp;
      return createTag(src, "/" + name, attributes);
    } else {
      try {
        var stats = fs.statSync(path.join(options.publicDir, assets));
        timestamp = stats.mtime.getTime();
      } catch (err) {
        throwError('file not found');
      }
      position = assets.lastIndexOf('.');
      //var name = _(assets).splice(position, 0, '.' + timestamp)
      var name = assets + '?cache=' + timestamp;
      return createTag(src, name, attributes);
    }
  } else {
    // Development mode just pump out assets normally
    var version = '?v=' + new Date().getTime();
    var buf = [];
    if (typeof assets === 'object') {
      for (var i = 0; i < assets.length; i += 1) {
        buf.push(createTag(src, assets[i], attributes, version));
        if ((i + 1) === assets.length) return buf.join("\n");
      }
    } else if (typeof assets === 'string') {
      return createTag(src, assets, attributes, version);
    } else {
      throwError('asset was not a string or an array');
    }
  }

};

/**
 * @param {import('aws-sdk').S3} S3 
 * @param {import('../index').CdnOptions} options
 * @param {string} text 
 * @param {string} fileName 
 * @param {object} headers 
 * @param {() => any} callback 
 */
var pushFileToS3 = function(S3, options, text, fileName, headers, callback) {
  var finishUpload = function() {
    return callback && callback();
  };
  zlib.gzip(text, function(err, buffer) {
    if (err) { throwError(err); }

    var operation = retry.operation();
    let s3Key = fileName;
    if (options.prefix) {
      s3Key = path.join(options.prefix, fileName);
    }
    operation.attempt(function(currentAttempt) {
      S3.putObject({
        Bucket: options.bucket,
        Key: s3Key,
        Body: buffer,
        ContentType: headers['Content-Type'],
        CacheControl: headers['Cache-Control'],
        Expires: new Date(new Date().getTime() + (31556926 * 1000)),
        ContentEncoding: headers['Content-Encoding'],
        ACL: 'public-read',
      }, function(err, response) {
        if (operation.retry(err)) { return; }
        if (response) {
          logger(`Uploaded to S3 successfully`, {
            task: 'express-cdn',
            fileName,
            key: s3Key,
          });
          return finishUpload();
        }
        if (err) {
          return throwError(operation.mainError());
        }
        throwError('unsuccessful upload of script "' + fileName + '" to S3');
      });
    });
  });
};

/**
 * 
 * @param {string} fileName 
 * @param {string[]} assets 
 * @param {import('aws-sdk').S3} S3 
 * @param {import('../index').CdnOptions} options 
 * @param {'uglify'|'minify'|'optipng'|'jpegtran'|'image'|'font'} method 
 * @param {string} type 
 * @param {Date} timestamp 
 * @param {() => void} callback 
 * @returns 
 */
var compile = function(fileName, assets, S3, options, method, type, timestamp, callback) {
  return function(err, results) {
    if (err) throwError(err);
    var expires = new Date(new Date().getTime() + (31556926 * 1000)).toUTCString();
    var headers = {
      'Set-Cookie': '',
      'response-content-type': type,
      'Content-Type': type,
      'response-cache-control': 'maxage=31556926',
      'Cache-Control': 'maxage=31556926',
      'response-expires': expires,
      'Expires': expires,
      'response-content-encoding': 'gzip',
      'Content-Encoding': 'gzip',
      'x-amz-acl': 'public-read'
    };
    switch (method) {
      case 'uglify':
        if (results instanceof Array) {
          results = results.join("\n");
        }
        
        try {
          const cacheDir = options.debug.tempDir;
          if (cacheDir) {
            fs.mkdirSync(cacheDir, { recursive: true});
            const cacheFile = path.join(cacheDir, fileName);
            fs.writeFileSync(cacheFile, results);
            logger(`Wrote to ${cacheFile}`, { task: 'express-cdn', fileName });
          }
        } catch (er) {
          logger('Unable to write temp file', { task: 'express-cdn', fileName, error: er });
        }
        var uglifyResult = uglify.minify(results);

        if (uglifyResult.error !== undefined) {
          logger('Failed to minify ' + fileName + ' due to uglify-js error.', {
            task: 'express-cdn',
            fileName,
            error: uglifyResult.error
          });
          if (options.continueOnFailure === false) {
            throwError(uglifyResult.error);
            return;
          }
        }
        logger('Uploading to S3 anyway', {
          task: 'express-cdn',
          fileName,
        });
        pushFileToS3(S3, options, uglifyResult.code ? uglifyResult.code : results, fileName, headers, callback);
        break;
      case 'minify':
        if (!(results instanceof Array)) {
          results = [results];
          assets = [assets]
        }
        var final_code = [];
        const compiles = [];
        // NOTE: Added back in clean CSS, looks like its a bit less bad at minifcation now

        for (var key in results) {
          var minify = new cleanCSS().minify(results[key]);
          minify = minify.styles;
          var assetPath = assets[key];
          var assetBasePath = path.dirname(assetPath);
          var fileBasePath = path.dirname(path.join(options.publicDir, fileName));
          

          // Process images
          minify = minify.replace(/(?:background\-image|background|content|border\-image|cursor)\:[^;\n]*\)/g, function(rootMatch) {

            //Multiples Images URL per background
            return rootMatch.replace(/url\((?!data:)['"]?([^\)'"]+)['"]?\)/g, function(match, url) {

              if (options.production) {
                var relativePath = url;
                if ('/' === relativePath[0]) {
                  relativePath = path.join(options.publicDir, relativePath.substr(1));
                } else {
                  relativePath = path.join(assetBasePath, relativePath);
                }
                var mimeType = mime.getType(relativePath);
                compiles.push([relativePath.substr(options.publicDir.length + 1), relativePath, S3, options, 'image', mimeType, Date.now()]);
                return 'url(' + path.relative(fileBasePath, relativePath) + ')';
              } else {
                return 'url(' + url + ')';
              }
            });
          });

          // Process fonts
          minify = minify.replace(/(?:src)\:[^;]*\)/g, function(rootMatch) {

            //Multiples Fonts URL per SRC
            return rootMatch.replace(/url\((?!data:)['"]?([^\)'"]+)['"]?\)/g, function(match, url) {

              if (options.production) {
                var relativePath = url;
                if ('/' === relativePath[0]) {
                  relativePath = path.join(options.publicDir, relativePath.substr(1));
                } else {
                  relativePath = path.join(assetBasePath, relativePath);
                }
                var mimeType = mime.getType(relativePath);
                compiles.push([relativePath.substr(options.publicDir.length + 1), relativePath, S3, options, 'font', mimeType, Date.now()]);
                return 'url(' + path.relative(fileBasePath, relativePath) + ')';
              } else {
                return 'url(' + url + ')';
              }
            });
          });

          final_code.push(minify);
        }

        async.map(compiles, (compileArgs, iter) => {
          compile(...compileArgs, () => iter(null, compileArgs))();
        }, (err, transformedCompiles) => {
          if (err) throwError(err);
          pushFileToS3(S3, options, final_code.join("\n"), fileName, headers, callback);
        })
        
        break;
      case 'optipng':
        var img = assets;
        var optipng = spawn(optipngPath, [img]);
        optipng.stdout.on('data', function(data) {
          logger('optipng: ' + data, {
            task: 'express-cdn',
          });
        });
        optipng.stderr.on('data', function(data) {
          logger('optipng: ' + data, {
            task: 'express-cdn',
          });
        });
        optipng.on('exit', function(code) {
          // OptiPNG returns 1 if an error occurs
          if (code !== 0 && options.continueOnFailure === false)
            throwError('optipng returned an error during processing \'' + img + '\': ' + code);
          else
            logger(`[optipng] optipng returned an error during processing '${img}': exit code = '${code}'`, {
              task: 'express-cdn',
            });
          fs.readFile(img, function(err, data) {
            pushFileToS3(S3, options, data, fileName, headers, callback);
          });
        });
        break;
      case 'jpegtran':
        var jpg = assets;
        var jpegtran = spawn(jpegtranPath, ['-copy', 'none', '-optimize', '-outfile', jpg, jpg]);
        jpegtran.stdout.on('data', function(data) {
          logger('jpegtran: ' + data, {
            task: 'express-cdn',
          });
        });
        jpegtran.stderr.on('data', function(data) {
          if (options.continueOnFailure === false)
            throwError(data);
          else
            logger('[jpegtran]', { fileName: jpg, task: 'express-cdn', error: data });
        });
        jpegtran.on('exit', function(code) {
          logger('jpegtran exited with code ' + code, {
            task: 'express-cdn',
          });
          fs.readFile(jpg, function(err, data) {
            pushFileToS3(S3, options, data, fileName, headers, callback);
          });
        });
        break;
      case 'image':
      case 'font':
        var image = assets.split("?")[0].split("#")[0];
        fileName = fileName.split("?")[0].split("#")[0];
        fs.readFile(image, function(err, data) {
          pushFileToS3(S3, options, data, fileName, headers, callback);
        });
        break;
    }
  };
};

var readUtf8 = function(file, callback) {
  fs.readFile(file, 'utf8', callback);
};

var js = ['application/javascript', 'text/javascript'];

/**
 * Check if the file already exists
 * @param {string[]} assets 
 * @param {string} fileName 
 * @param {import('aws-sdk').S3} S3 S3 Instance
 * @param {import('../index').CdnOptions} options Options
 * @param {Date} timestamp 
 * @param {string} type 
 * @param {(err?: Error, assets: string[]) => any} callback 
 */
var checkArrayIfModified = function(assets, fileName, S3, options, timestamp, type, callback) {
  var finishUpload = function() {
    return callback && callback(null, assets);
  };
  return function(/** @type {import('aws-sdk').AWSError} */err, /** @type {import('aws-sdk').S3.HeadObjectOutput} */ response) {
    if (response && timestamp <= response.LastModified.getTime()) {
      logger('"' + fileName + '" not modified and is already stored on S3', {
        task: 'express-cdn',
      });
      return finishUpload();
    } else if(err && err.code === 'NotFound' || response && timestamp > response.LastModified.getTime()) {
      logger('"' + fileName + '" was not found on S3 or was modified recently', {
        task: 'express-cdn',
      });
      // Check file type
      switch (type) {
        case 'application/javascript':
        case 'text/javascript':
          async.map(assets, readUtf8, compile(fileName, assets, S3, options, 'uglify', type, null, finishUpload));
          return;
        case 'text/css':
          async.map(assets, readUtf8, compile(fileName, assets, S3, options, 'minify', type, null, finishUpload));
          return;
        default:
          throwError('unsupported mime type array "' + type + '"');
      }
    } else if (err) {
      throwError(err);
    } else {
      throwError('Unhandled case');
    }
  };
};

/**
 * Check if the file already exists
 * @param {string[]} assets 
 * @param {string} fileName 
 * @param {import('aws-sdk').S3} S3 S3 Instance
 * @param {import('../index').CdnOptions} options Options
 * @param {Date} timestamp 
 * @param {(err?: Error, assets: string[]) => any} callback 
 */
var checkStringIfModified = function(assets, fileName, S3, options, timestamp, callback) {
  var finishUpload = function() {
    return callback && callback(null, assets);
  };
  return function(/** @type {import('aws-sdk').AWSError} */err, /** @type {import('aws-sdk').S3.HeadObjectOutput} */ response) {
    // Exists and unchanged
    if (response && timestamp <= response.LastModified.getTime()) {
      logger('"' + fileName + '" not modified and is already stored on S3', {
        task: 'express-cdn',
      });
      return finishUpload();
    } else if(err && err.code === 'NotFound' || response && timestamp > response.LastModified.getTime()) {
      logger('"' + fileName + '" was not found on S3 or was modified recently', {
        task: 'express-cdn'
      });
      // Check file type
      var type = mime.getType(assets);
      switch (type) {
        case 'application/javascript':
        case 'text/javascript':
          readUtf8(assets, compile(fileName, assets, S3, options, 'uglify', type, null, finishUpload));
          return;
        case 'text/css':
          readUtf8(assets, compile(fileName, assets, S3, options, 'minify', type, null, finishUpload));
          return;
        case 'image/gif':
        case 'image/x-icon':
        case 'image/svg+xml':
          compile(fileName, assets, S3, options, 'image', type, timestamp, finishUpload)(null, null);
          return;
        case 'image/png':
          compile(fileName, assets, S3, options, 'optipng', type, timestamp, finishUpload)(null, null);
          return;
        case 'image/jpg':
        case 'image/jpeg':
        case 'image/pjpeg':
          compile(fileName, assets, S3, options, 'jpegtran', type, timestamp, finishUpload)(null, null);
          return;
        case 'image/x-icon':
        case 'image/vnd.microsoft.icon':
          compile(fileName, assets, S3, options, 'image', type, timestamp, finishUpload)(null, null);
        default:
          throwError('unsupported mime type "' + type + '"');
      }
    } else if (err) { 
      throwError(err);
    } else {
      throwError('Unhandled case');
    }
  };
};

/**
 * @param {import('../index').CdnOptions} options 
 */
var processAssets = function(options, results, done) {
  // Create knox instance
  aws.config.update({ accessKeyId: options.key, secretAccessKey: options.secret });
  var S3 = new aws.S3({ signatureVersion: 'v4', region: options.region });
  // var S3 = knox.createClient({
  //   key: options.key,
  //   secret: options.secret,
  //   bucket: options.bucket,
  //   region: options.region || 'us-standard',
  //   endpoint: options.endpoint || null
  // });

  // Go through each result and process it
  async.map(results, function(result, iter) {
    var assets = result,
      type = '',
      fileName = '', position,
      timestamp = 0;
    // Combine the assets if it is an array
    if (assets instanceof Array) {
      // Concat the file names together
      var concat = [];
      // Ensure all assets are of the same type
      for (var k = 0; k < assets.length; k += 1) {
        if (type === '')
          type = mime.getType(assets[k]);else if (mime.getType(assets[k]) !== type)
          throwError('mime types in array do not match');
        assets[k] = path.join(options.publicDir, assets[k]);
        timestamp = Math.max(timestamp, fs.statSync(assets[k]).mtime.getTime());

        concat.push(path.basename(assets[k]));
      }
      // Set the file name
      fileName = concat.join("+");
      position = fileName.lastIndexOf('.');
      let s3Key = fileName;
      if (options.prefix) {
        s3Key = path.join(options.prefix, fileName)
      }
      //fileName = _(fileName).splice(position, 0, '.' + timestamp);
      S3.headObject({ Bucket: options.bucket, Key: s3Key }, checkArrayIfModified(assets, fileName, S3, options, timestamp, type, iter));
    } else {
      // Set the file name
      fileName = assets.substr(1);
      let s3Key = fileName;
      if (options.prefix) {
        s3Key = path.join(options.prefix, fileName)
      }
      assets = path.join(options.publicDir, assets);
      position = fileName.lastIndexOf('.');
      fs.exists(assets, function(exists) {
        if (exists) {
          timestamp = fs.statSync(assets).mtime.getTime();
        }
        S3.headObject({ Bucket: options.bucket, Key: s3Key }, checkStringIfModified(assets, fileName, S3, options, timestamp, iter));
      });
    }
  }, function(err, results) {
    done(err, results);
  });
};

/**
 * 
 * @param {import('express').Application} app Express Application
 * @param {import('../index').CdnOptions} options Module options
 * @param {import('fs').NoParamCallback} [callback] Optional callback
 */
var CDN = function(app, options, callback) {

  // Validate express - Express app instance is an object in v2.x.x and function in 3.x.x
  if (!(typeof app === 'object' || typeof app === 'function')) throwError('requires express');

  // Validate options
  var required = [
    'publicDir',
    'viewsDir',
    'ssl',
    'production',
  ];
  const requiredProduction = [
    'domain',
    'bucket',
    'key',
    'secret',
  ];
  required.concat(options.production ? requiredProduction : []).forEach(function(index) {
    if (typeof options[index] === 'undefined') {
      throwError('missing option "' + index + '"');
    }
  });

  if (options.logger) {
    if (typeof options.logger === 'function')
      logger = options.logger;
  }

  if (!options.debug) {
    options.debug = {};
  }

  if (options.production && !options.disableWalk) {
    var walker = function() {
      var walker = walk.walk(options.viewsDir),
        results = [],
        regexCDN = /CDN\(((\([^)]+\)|[^)])+)\)/ig;
      walker.on('file', function(root, stat, next) {
        var validExts = options.extensions || ['.jade', '.ejs', '.pug'];
        var ext = path.extname(stat.name), text;

        if (_.indexOf(validExts, ext) !== -1) {
          fs.readFile(path.join(root, stat.name), 'utf8', function(err, data) {
            if (err) throwError(err);
            var match;
            while ((match = regexCDN.exec(data))) {
              results.push(match[1]);
            }
            next();
          });
        } else {
          next();
        }
      });
      walker.on('end', function() {
        // Clean the array
        for (var i = 0; i < results.length; i += 1) {
          // Convert all apostrophes
          results[i] = results[i].replace(/\'/g, '"');
          // Insert assets property name
          results[i] = _(results[i]).splice(0, 0, '"assets": ');
          // Check for attributes
          var attributeIndex = results[i].indexOf('{');
          if (attributeIndex !== -1)
            results[i] = _(results[i]).splice(attributeIndex, 0, '"attributes": ');
          // Convert to an object
          results[i] = '{ ' + results[i] + ' }';
          results[i] = JSON.parse(results[i]);
        }
        // Convert to an array of only assets
        var out = [];
        for (var k = 0; k < results.length; k += 1) {
          out[results[k].assets] = results[k].assets;
        }
        var clean = [];
        for (var c in out) {
          clean.push(out[c]);
        }
        // Process the results
        if (clean.length > 0) {
          processAssets(options, clean, function(err, results) {
            if (options.cache_file) {
              fs.writeFile(options.cache_file, JSON.stringify(results), function() {
                logger('Wrote results to cache file', {
                  task: 'express-cdn'
                })
                return callback && callback();
              });
            } else {
              logger('CDN initialized', {
                task: 'express-cdn'
              });
              return callback && callback();
            }
          });
        } else {
          logger('CDN initialized', {
            task: 'express-cdn'
          });
          return callback && callback();
        }
      });
    };

    if (options.cache_file) {
      fs.stat(options.cache_file, function(err, cache_stat) {
        if (err || !(cache_stat && cache_stat.isFile() && cache_stat.size > 0)) {
          walker();
        } else {
          // results are cached, everything already processed and on S3
        }
      });
    } else {
      walker();
    }
  } else {
    // Fix for promise not resolving
    setTimeout(() => {
      if (callback) callback();
    }, 0);
  }

  // Return the dynamic view helper
  return function(req, res) {
    return function(assets, attributes) {
      if (typeof assets === 'undefined') throwError('assets undefined');
      return renderTag(options, assets, attributes);
    };
  };
};

module.exports = CDN;

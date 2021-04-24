import express from 'express';

export interface CdnOptions {
  /**
   * The path to the public directory
   */
  publicDir: string;
  /**
   * The path to the views directory
   */
  viewsDir: string;
  /**
   * A custom domain to use for CDN
   */
  domain: string;
  /**
   * The Amazon S3 bucket to upload to
   */
  bucket: string;
  /**
   * The Amazon S3 Access Key
   */
  key: string;
  /**
   * The Amazon S3 Secret Key
   */
  secret: string;
  /**
   * The Amazon S3 Region
   */
  region: string | 'ca-central-1';
  /**
   * Provide an S3 endpoint override. Omit the bucket name from this value.
   * @deprecated Not using knox anymore
   */
  endpoint: string;
  /**
   * Force the CDN links to be http, https, or relative to the request
   */
  ssl: 'relative' | boolean;
  /**
   * Production switch
   */
  production: boolean;
  /**
   * Custom logging function
   */
  logger: (msg: string) => void;
  /**
   * Debugging
   */
  debug?: {
    /**
     * Provide a directory to store js sent to uglify-js for debugging
     */
    tempDir?: string;
  },
  /**
   * Allow unminified JS to be uploaded
   */
  allowUnminified: boolean;
  /**
   * Disable walking
   */
  disableWalk: boolean;
  /**
   * An array of extensions
   */
  extensions: string[];
  /**
   * Who knows
   */
  cache_file: string;
}

export function CDN(app: express.Application, options: CdnOptions, callback: () => void): (req: express.Request, res: express.Response) => (assets: string | string[], attributes: {}) => string;

export = CDN;
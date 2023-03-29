// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  RemovalPolicy,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_lambda as lambda,
  aws_iam as iam,
  Duration,
  CfnOutput,
  aws_logs as logs,
  Fn as cdkFn,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { createHash } from 'crypto';

type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?: any;
  transformedImageCacheTTL: string,
  secretKey: string,
  logTiming: string,
}

export interface ImageOptimizationServiceProps {
  // Should the transformed image results be saved in an S3 bucket.
  // (Recommended) If disabled, images will have to be transformed on every
  // request that does not hit the CloudFront cache.
  storeTransformedImages: boolean;

  // If set, the image optimization service will attempt to connect to an
  // existing bucket with this name rather than creating a new bucket.
  existingS3ImageBucketName?: string;

  // The CloudFront Origin Shield region.
  cloudFrontOriginShieldRegion: string;
  // Whether CORS is enabled for the CloudFront distribution.
  cloudFrontCorsEnabled: boolean;

  // The number of days that transformed images are kept in S3.
  // Default: 90
  transformedImageS3ExpirationDays?: number;
  // The cache-control header used for transformed images.
  // Default (one year): "max-age=31622400"
  transformedImageCacheControl?: string;

  // The amount of memory (in MB) allocated for the image transform lambda
  // function.
  // Default: 1500
  imageTransformLambdaMemoryMB?: number;
  // The timeout (in seconds) for the image transform lambda function.
  // Default: 60
  imageTransformLambdaTimeoutSecs?: number;
  // Whether to log timing information in the image transform lambda function.
  imageTransformLambdaLogTiming?: boolean;
}

export class ImageOptimizationService extends Construct {
  constructor(scope: Construct, id: string, props: ImageOptimizationServiceProps) {
    super(scope, id);

    // Create secret key to be used between CloudFront and Lambda URL for access control.
    const cloudFrontToLambdaSecretKey = createHash('md5').update(this.node.addr).digest('hex');

    // For the original image bucket, either use an existing one, or create one
    // with some sample photos.
    var originalImageBucket;
    var transformedImageBucket;
    if (props.existingS3ImageBucketName != undefined) {
      originalImageBucket = s3.Bucket.fromBucketName(
        this, 'ExistingOriginalImageBucket', props.existingS3ImageBucketName);
    } else {
      originalImageBucket = new s3.Bucket(this, 'OriginalImageBucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
      });
      new s3deploy.BucketDeployment(this, 'DeploySampleImages', {
        sources: [s3deploy.Source.asset('./image-sample')],
        destinationBucket: originalImageBucket,
        destinationKeyPrefix: 'images/rio/',
      });
    }
    new CfnOutput(this, 'OriginalImagesS3Bucket', {
      description: 'S3 bucket where original images are stored.',
      value: originalImageBucket.bucketName
    });

    // Create bucket for transformed images if enabled.
    if (props.storeTransformedImages) {
      transformedImageBucket = new s3.Bucket(this, 'TransformedImageBucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [{
          expiration: Duration.days(props.transformedImageS3ExpirationDays ?? 90),
        }],
      });
    }

    // Env variables for the image transformation Lambda. 
    var lambdaEnv: LambdaEnv = {
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageCacheTTL: props.transformedImageCacheControl ?? "max-age=31622400",
      secretKey: cloudFrontToLambdaSecretKey,
      logTiming: props.imageTransformLambdaLogTiming ? "true" : "false",
    };
    if (transformedImageBucket) {
      lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;
    }

    // IAM policy to read from the S3 bucket containing the original images.
    const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
    });
    // Statements of the IAM policy to attach to the image transformation Lambda.
    var iamPolicyStatements = [s3ReadOriginalImagesPolicy];

    // Create Lambda for image processing.
    var lambdaProps = {
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(props.imageTransformLambdaTimeoutSecs ?? 60),
      memorySize: props.imageTransformLambdaMemoryMB ?? 1500,
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.FIVE_DAYS,
    };
    var imageProcessing = new lambda.Function(this, 'ImageTransformationLambda', lambdaProps);

    // Enable Lambda URL.
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    // Extract lambda URL hostname based on https://stackoverflow.com/a/72010828.
    const imageProcessingHostname = cdkFn.select(2, cdkFn.split('/', imageProcessingURL.url));

    // Create a CloudFront origin: S3 with fallback to Lambda when image needs
    // to be transformed.
    var imageOrigin;
    if (transformedImageBucket) {
      imageOrigin = new origins.OriginGroup({
        primaryOrigin: new origins.S3Origin(transformedImageBucket, {
          originShieldRegion: props.cloudFrontOriginShieldRegion,
        }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingHostname, {
          originShieldRegion: props.cloudFrontOriginShieldRegion,
          customHeaders: {
            'x-origin-secret-header': cloudFrontToLambdaSecretKey,
          },
        }),
        fallbackStatusCodes: [403],
      });

      // Write policy for Lambda on the S3 bucket for transformed images.
      var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
      });
      iamPolicyStatements.push(s3WriteTransformedImagesPolicy);
    } else {
      imageOrigin = new origins.HttpOrigin(imageProcessingHostname, {
        originShieldRegion: props.cloudFrontOriginShieldRegion,
        customHeaders: {
          'x-origin-secret-header': cloudFrontToLambdaSecretKey,
        },
      });
    }

    // Attach IAM policy to the role assumed by Lambda.
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'ReadWriteBucketPolicy', {
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites.
    const urlRewriteFunction = new cloudfront.Function(this, 'UrlRewriteFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: `urlRewriteFunction${this.node.addr}`,
    });

    var imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy`, {
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
      }),
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    if (props.cloudFrontCorsEnabled) {
      // Create a custom response headers policy. CORS allowed for all origins.
      const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
        this, 'ImageResponsePolicy',
        {
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET'],
            accessControlAllowOrigins: ['*'],
            accessControlMaxAge: Duration.seconds(600),
            originOverride: false,
          },
          // Set header to make it clear when image requests were processed by
          // this solution.
          customHeadersBehavior: {
            customHeaders: [
              { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
              { header: 'vary', value: 'accept', override: true },
            ],
          }
        }
      );
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy;
    }
    const imageDelivery = new cloudfront.Distribution(this, 'ImageDeliveryDistribution', {
      comment: 'image optimization - image delivery',
      defaultBehavior: imageDeliveryCacheBehaviorConfig
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery CloudFront distribution.',
      value: imageDelivery.distributionDomainName
    });
  }
}

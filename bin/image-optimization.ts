#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DefaultImageOptimizationStack } from '../lib/default_image_optimization_stack';


// AWS Region to Origin Shield Region mapping based on latency.
// To be updated when new Regional Edge Caches are added to CloudFront.
const ORIGIN_SHIELD_MAPPING = new Map([
  ['af-south-1', 'eu-west-2'],
  ['ap-east-1', 'ap-northeast-2'],
  ['ap-northeast-1', 'ap-northeast-1'],
  ['ap-northeast-2', 'ap-northeast-2'],
  ['ap-northeast-3', 'ap-northeast-1'],
  ['ap-south-1', 'ap-south-1'],
  ['ap-southeast-1', 'ap-southeast-1'],
  ['ap-southeast-2', 'ap-southeast-2'],
  ['ca-central-1', 'us-east-1'],
  ['eu-central-1', 'eu-central-1'],
  ['eu-north-1', 'eu-central-1'],
  ['eu-south-1', 'eu-central-1'],
  ['eu-west-1', 'eu-west-1'],
  ['eu-west-2', 'eu-west-2'],
  ['eu-west-3', 'eu-west-2'],
  ['me-south-1', 'ap-south-1'],
  ['sa-east-1', 'sa-east-1'],
  ['us-east-1', 'us-east-1'],
  ['us-east-2', 'us-east-2'],
  ['us-west-1', 'us-west-1'],
  ['us-west-2', 'us-west-2'],
]);

const app = new cdk.App();

const CLOUDFRONT_ORIGIN_SHIELD_REGION = app.node.tryGetContext("CLOUDFRONT_ORIGIN_SHIELD_REGION");
if (CLOUDFRONT_ORIGIN_SHIELD_REGION == undefined) {
  throw new Error("CLOUDFRONT_ORIGIN_SHIELD_REGION is undefined. (See ORIGIN_SHIELD_MAPPING for suggestions.)");
}

new DefaultImageOptimizationStack(app, 'Staging', {
  cloudFrontOriginShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
});

new DefaultImageOptimizationStack(app, 'Production', {
  cloudFrontOriginShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
});

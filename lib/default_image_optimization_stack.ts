
import {
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ImageOptimizationService } from './image_optimization_service';


interface DefaultImageOptimizationStackProps extends StackProps {
  cloudFrontOriginShieldRegion: string;
}

/**
 * A default image optimization stack. Most settings are fixed. Only the
 * CloudFront Origin Shield region needs to be specified.
 */
export class DefaultImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props: DefaultImageOptimizationStackProps) {
    super(scope, id, props);

    new ImageOptimizationService(this, 'ImageOptimizationService', {
      storeTransformedImages: true,
      cloudFrontOriginShieldRegion: props.cloudFrontOriginShieldRegion,
      cloudFrontCorsEnabled: true,
    });
  }
}

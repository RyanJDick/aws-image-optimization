// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const S3 = new AWS.S3({ signatureVersion: 'v4', httpOptions: { agent: new https.Agent({ keepAlive: true }) } });
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const SECRET_KEY = process.env.secretKey;
const LOG_TIMING = process.env.logTiming;

exports.handler = async (event) => {
    // Validate that the request is coming from CloudFront.
    if (
        !event.headers['x-origin-secret-header'] ||
        !(event.headers['x-origin-secret-header'] === SECRET_KEY)
    ) {
        return sendError(403, 'Request unauthorized.', event);
    }

    // Validate that it is a GET request.
    if (
        !event.requestContext ||
        !event.requestContext.http ||
        !(event.requestContext.http.method === 'GET')
    ) {
        return sendError(400, 'Only GET method is supported.', event);
    }

    // Examples  of expected http paths:
    //   - /rio/images/1.jpg/format=auto,width=100
    //   - /rio/images/1.jpg/original
    var imagePathArray = event.requestContext.http.path.split('/');
    // Get the requested image operations. (e.g. "format=auto,width=100")
    var operationsPrefix = imagePathArray.pop();
    // Get the original image path. (e.g. images/rio/1.jpg)
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');

    // Timing variables.
    var timingLog = "perf ";
    var startTime = performance.now();

    // Download original image.
    let originalImage;
    let contentType;
    try {
        originalImage = await S3.getObject({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath }).promise();
        contentType = originalImage.ContentType;
    } catch (error) {
        return sendError(500, 'Error downloading original image.', error);
    }

    // Split operationsPrefix into individual fields.
    let operations = {};
    let operationsArray = operationsPrefix.split(',');
    operationsArray.forEach(operation => {
        let operationKV = operation.split("=");
        operations[operationKV[0]] = operationKV[1];
    });

    // Perform the requested image transformation.
    let sharpImage = Sharp(originalImage.Body);
    timingLog = timingLog + parseInt(performance.now() - startTime) + ' ';
    startTime = performance.now();
    try {
        // Keep the correct orientation while still discarding all other EXIF data.
        sharpImage = sharpImage.rotate();

        // Apply resizing if requested.
        var resizingOptions = {};
        if (operations['width']) resizingOptions.width = parseInt(operations['width']);
        if (operations['height']) resizingOptions.height = parseInt(operations['height']);
        if (resizingOptions) sharpImage = sharpImage.resize(resizingOptions);

        // Apply formatting if requested.
        if (operations['format']) {
            var isLossy = false;
            switch (operations['format']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'svg': contentType = 'image/svg+xml'; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operations['quality'] && isLossy) {
                sharpImage = sharpImage.toFormat(operations['format'], {
                    quality: parseInt(operations['quality']),
                });
            } else sharpImage = sharpImage.toFormat(operations['format']);
        }
        sharpImage = await sharpImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }

    timingLog = timingLog + parseInt(performance.now() - startTime) + ' ';
    startTime = performance.now();

    // Upload transformed image back to S3 if this feature is enabled.
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        try {
            await S3.putObject({
                Body: sharpImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
            }, function (err, data) { }).promise();
        } catch (error) {
            return sendError(500, 'Could not upload transformed image to S3.', error);
        }
    }

    timingLog = timingLog + parseInt(performance.now() - startTime) + ' ';
    if (LOG_TIMING === 'true') console.log(timingLog);

    // Return the transformed image.
    return {
        statusCode: 200,
        body: sharpImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
        }
    };
};

function sendError(code, message, error) {
    console.log('APPLICATION ERROR', message);
    console.log(error);
    return {
        statusCode: code,
        body: message,
    };
}

import { createHash } from 'node:crypto';

export const SOURCE_PREPARATION_PIPELINE_VERSION = 'source-preparation-v1';
export const SOURCE_PREPARATION_STAGE_KEY = 'source.media.prepare';
export const SOURCE_PREPARATION_EVENT = 'workflow.stage.execute';

export const SOURCE_PREPARATION_CONFIGURATION = {
  analysisAudio: { channels: 1, codec: 'flac', sampleRateHz: 16_000 },
  canonicalAudio: { codec: 'flac', sampleRateHz: 48_000 },
  contract: 'voiceverse.media-preparation.v1',
  pipeline: SOURCE_PREPARATION_PIPELINE_VERSION,
} as const;

const configuration = JSON.stringify(SOURCE_PREPARATION_CONFIGURATION);

/**
 * Versioned snapshot of every output-affecting source-preparation option.
 * Attempts persist this value so artifacts remain reproducible after defaults evolve.
 */
export const SOURCE_PREPARATION_CONFIGURATION_HASH = createHash('sha256')
  .update(configuration)
  .digest('hex');

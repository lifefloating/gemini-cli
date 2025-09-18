/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { type Config, AuthType } from '@google/gemini-cli-core';
import { GeminiPrivacyNotice } from './GeminiPrivacyNotice.js';
import { CloudPaidPrivacyNotice } from './CloudPaidPrivacyNotice.js';
import { CloudFreePrivacyNotice } from './CloudFreePrivacyNotice.js';
import { theme } from '../semantic-colors.js';

interface PrivacyNoticeProps {
  onExit: () => void;
  config: Config;
  ctrlCPressedOnce?: boolean;
}

const PrivacyNoticeText = ({
  config,
  onExit,
}: {
  config: Config;
  onExit: () => void;
}) => {
  const authType = config.getContentGeneratorConfig()?.authType;

  switch (authType) {
    case AuthType.USE_GEMINI:
      return <GeminiPrivacyNotice onExit={onExit} />;
    case AuthType.USE_VERTEX_AI:
      return <CloudPaidPrivacyNotice onExit={onExit} />;
    case AuthType.LOGIN_WITH_GOOGLE:
    default:
      return <CloudFreePrivacyNotice config={config} onExit={onExit} />;
  }
};

export const PrivacyNotice = ({
  onExit,
  config,
  ctrlCPressedOnce = false,
}: PrivacyNoticeProps) => (
  <Box borderStyle="round" padding={1} flexDirection="column">
    <PrivacyNoticeText config={config} onExit={onExit} />
    {ctrlCPressedOnce && (
      <Box marginTop={1}>
        <Text color={theme.status.warning}>Press Ctrl+C again to exit.</Text>
      </Box>
    )}
  </Box>
);

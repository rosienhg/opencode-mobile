import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

import { CredentialRequestCard } from '@/components/credentials/credential-request-card';
import type { HermesCredentialsState } from '@/providers/use-hermes-credentials';
import { usePalette } from '@/hooks/use-palette';

type CredentialsViewProps = {
  credentials: HermesCredentialsState;
  onRefresh: () => void;
};

export function CredentialsView({ credentials, onRefresh }: CredentialsViewProps) {
  const { t } = useTranslation();
  const palette = usePalette();

  if (credentials.pluginMissing) {
    return (
      <View style={styles.center} testID="credentials-plugin-missing">
        <Text variant="titleMedium" style={{ color: palette.text }}>{t('credentials:title')}</Text>
        <Text variant="bodyMedium" style={{ color: palette.muted, textAlign: 'center' }}>{t('credentials:pluginMissing')}</Text>
        <Button mode="outlined" onPress={onRefresh}>{t('common:actions.retry')}</Button>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.list}
      contentInsetAdjustmentBehavior="automatic"
    >
      {credentials.loading && credentials.requests.length === 0 ? <ActivityIndicator style={styles.loading} color={palette.tint} /> : null}
      {credentials.error ? <Text variant="bodySmall" style={{ color: palette.danger }}>{t('credentials:loadError')}</Text> : null}

      {credentials.requests.length === 0 && !credentials.loading ? (
        <Text variant="bodyMedium" style={{ color: palette.muted, textAlign: 'center', marginTop: 32 }}>{t('credentials:empty')}</Text>
      ) : null}

      {credentials.pending.length > 0 ? (
        <>
          <Text variant="titleSmall" style={{ color: palette.text, marginTop: 8 }}>{t('credentials:pending')}</Text>
          {credentials.pending.map((request) => (
            <CredentialRequestCard
              key={request.id}
              request={request}
              palette={palette}
              onFulfill={credentials.fulfill}
              onCancel={credentials.cancel}
            />
          ))}
        </>
      ) : null}

      {credentials.history.length > 0 ? (
        <>
          <Text variant="titleSmall" style={{ color: palette.text, marginTop: 16 }}>{t('credentials:history')}</Text>
          {credentials.history.map((request) => (
            <CredentialRequestCard
              key={request.id}
              request={request}
              palette={palette}
              onFulfill={credentials.fulfill}
              onCancel={credentials.cancel}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  list: { padding: 16, paddingBottom: 32, gap: 4 },
  loading: { marginTop: 32 },
});

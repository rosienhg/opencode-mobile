import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Button, Card, Text, TextInput } from 'react-native-paper';

import { formatTimestamp } from '@/lib/opencode/format';
import type { CredentialRequestView } from '@/lib/hermes/mapping';
import { usePalette } from '@/hooks/use-palette';

type CredentialRequestCardProps = {
  request: CredentialRequestView;
  palette: ReturnType<typeof usePalette>;
  onFulfill: (id: string, values: Record<string, string>) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
};

// One credential request: pending requests expose a secret-entry form; history
// entries show where the values were stored without ever showing the values.
export function CredentialRequestCard({ request, palette, onFulfill, onCancel }: CredentialRequestCardProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const statusLabel = request.status === 'filled'
    ? t('credentials:fulfilled')
    : request.status === 'cancelled' ? t('credentials:cancelled') : t('credentials:expired');

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await onFulfill(request.id, values);
      setValues({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentials:fulfillError'));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest() {
    setBusy(true);
    setError(undefined);
    try {
      await onCancel(request.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentials:loadError'));
    } finally {
      setBusy(false);
    }
  }

  if (!request.pending) {
    return (
      <Card mode="outlined" style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]}>
        <Card.Content style={styles.content}>
          <View style={styles.headerRow}>
            <Text variant="titleMedium" style={{ color: palette.text, flex: 1 }}>{request.title}</Text>
            <Text variant="labelMedium" style={{ color: palette.muted }}>{statusLabel}</Text>
          </View>
          {request.why ? <Text variant="bodySmall" style={{ color: palette.muted }}>{t('credentials:why', { why: request.why })}</Text> : null}
          {request.saved.length > 0 ? (
            <View style={styles.savedList}>
              {request.saved.map((entry, index) => (
                <Text key={`${entry.field}-${index}`} variant="bodySmall" style={{ color: palette.muted }}>
                  • {entry.dest}
                </Text>
              ))}
            </View>
          ) : null}
        </Card.Content>
      </Card>
    );
  }

  const missing = request.fields.filter((field) => !String(values[field.name] ?? '').trim());

  return (
    <Card mode="outlined" style={[styles.card, { borderColor: palette.border, backgroundColor: palette.surface }]} testID={`credential-request-${request.id}`}>
      <Card.Content style={styles.content}>
        <View style={styles.headerRow}>
          <Text variant="titleMedium" style={{ color: palette.text, flex: 1 }}>{request.title}</Text>
          {request.expiresAt ? <Text variant="labelSmall" style={{ color: palette.muted }}>{t('credentials:expires', { time: formatTimestamp(request.expiresAt) })}</Text> : null}
        </View>
        {request.why ? <Text variant="bodySmall" style={{ color: palette.muted }}>{t('credentials:why', { why: request.why })}</Text> : null}
        {request.requester ? <Text variant="labelSmall" style={{ color: palette.muted }}>{t('credentials:requester', { requester: request.requester })}</Text> : null}
        <View style={styles.fields}>
          {request.fields.map((field) => (
            <View key={field.name}>
              <TextInput
                label={field.label}
                mode="outlined"
                dense
                secureTextEntry={field.secret && !revealed[field.name]}
                autoCapitalize="none"
                autoCorrect={false}
                multiline={!field.secret && (field.hint?.length ?? 0) > 80}
                value={values[field.name] ?? ''}
                onChangeText={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
                right={field.secret
                  ? <TextInput.Icon icon={revealed[field.name] ? 'eye-off' : 'eye'} onPress={() => setRevealed((current) => ({ ...current, [field.name]: !current[field.name] }))} />
                  : undefined}
                style={{ backgroundColor: palette.background }}
                testID={`credential-field-${field.name}`}
              />
              {field.hint ? <Text variant="labelSmall" style={{ color: palette.muted, marginTop: 2 }}>{field.hint}</Text> : null}
              <Text variant="labelSmall" style={{ color: palette.muted, marginTop: 2 }}>{t('credentials:fieldDestination', { destination: field.destination })}</Text>
            </View>
          ))}
        </View>
        {error ? <Text variant="bodySmall" style={{ color: palette.danger }}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button
            mode="contained"
            onPress={() => void submit()}
            disabled={busy || missing.length > 0}
            testID={`credential-fulfill-${request.id}`}
          >
            {t('credentials:fulfill')}
          </Button>
          <Button mode="outlined" onPress={() => void cancelRequest()} disabled={busy} textColor={palette.danger}>
            {t('common:actions.cancel')}
          </Button>
        </View>
        <Text variant="labelSmall" style={{ color: palette.muted }}>{t('credentials:secretsCleared')}</Text>
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  content: { gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fields: { gap: 10, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  savedList: { gap: 2, marginTop: 2 },
});

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { List } from 'react-native-paper';

import { usePalette } from '@/hooks/use-palette';

// Hermes connects by entering the dashboard address and signing in; there is
// no QR pairing or hosted cloud option to choose between.
export function ConnectionMethodChooser({ onManual }: { onManual: () => void }) {
  const { t } = useTranslation();
  const palette = usePalette();
  const choiceStyle = { minHeight: 96, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface };
  const titleStyle = { color: palette.text, fontWeight: '600' as const };
  const descriptionStyle = { color: palette.muted };
  return <View testID="connection-method-chooser" style={{ gap: 12 }}>
    <List.Item accessibilityRole="button" style={choiceStyle} titleStyle={titleStyle} descriptionStyle={descriptionStyle} testID="connection-method-manual" title={t('settings:connect.manual')} description={t('settings:connect.manualHint')} left={(props) => <List.Icon {...props} icon="server" color={palette.tint} />} right={(props) => <List.Icon {...props} icon="chevron-right" color={palette.muted} />} onPress={onManual} />
  </View>;
}

import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { CredentialsView } from '@/components/credentials/credentials-view';
import { useConnection, useCredentials } from '@/providers/opencode-contexts';
import { usePalette } from '@/hooks/use-palette';

export default function CredentialsScreen() {
  const palette = usePalette();
  const { connection } = useConnection();
  const { credentials } = useCredentials();
  const { load } = credentials;

  useFocusEffect(useCallback(() => {
    if (connection.status === 'connected') {
      void load();
    }
  }, [connection.status, load]));

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]} testID="credentials-screen">
      <CredentialsView
        credentials={credentials}
        onRefresh={() => { void load(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});

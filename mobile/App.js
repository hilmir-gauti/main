/**
 * Rafræn Þjónusta — app fyrir eigendur (iOS og Android).
 *
 * The business owner pairs the phone once with a six-character code from the
 * control panel, then sees today's diary and gets a push notification the
 * moment a booking arrives — from the website or from the phone receptionist.
 *
 * Deliberately a single file. The app has four screens' worth of behaviour and
 * one dependency-light job: show the diary and act on it. A navigation library
 * and a state manager would be more code than the app itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Platform, Pressable, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, useColorScheme, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';

const API_BASE = Constants.expoConfig?.extra?.apiBase ?? 'http://localhost:8080';
const TOKEN_KEY = 'rth.deviceToken';
const TENANT_KEY = 'rth.tenantName';

// Booking alerts must interrupt — a salon owner needs to see a cancellation
// before the customer's slot comes round.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.skilabod || 'Eitthvað fór úrskeiðis.');
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * Registers for push and returns the Expo token.
 * Returns null on a simulator or when the user declines — pairing still works,
 * the phone just will not receive alerts.
 */
async function registerForPush() {
  if (!Device.isDevice) return null;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const request = await Notifications.requestPermissionsAsync();
    status = request.status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('bokanir', {
      name: 'Bókanir',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1d4ed8',
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return token.data;
}

// ---------------------------------------------------------------------------
// Pairing screen
// ---------------------------------------------------------------------------

function PairingScreen({ onPaired, theme }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pair = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const pushToken = await registerForPush();
      const result = await api('/api/app/para', {
        method: 'POST',
        body: {
          kodi: code.trim().toUpperCase(),
          pushToken: pushToken ?? '',
          kerfi: Platform.OS === 'android' ? 'android' : 'ios',
          heiti: Device.deviceName || 'Sími',
        },
      });

      await AsyncStorage.multiSet([
        [TOKEN_KEY, result.lykill],
        [TENANT_KEY, result.fyrirtaeki.nafn],
      ]);
      onPaired(result.lykill, result.fyrirtaeki.nafn);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [code, onPaired]);

  return (
    <View style={[styles.center, { backgroundColor: theme.bg }]}>
      <Text style={[styles.title, { color: theme.ink }]}>Rafræn Þjónusta</Text>
      <Text style={[styles.muted, { color: theme.muted, textAlign: 'center', marginBottom: 28 }]}>
        Sláðu inn pörunarkóðann sem þú fékkst frá þjónustuaðilanum.
      </Text>

      <TextInput
        value={code}
        onChangeText={setCode}
        placeholder="ABC-123"
        placeholderTextColor={theme.muted}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={9}
        style={[styles.codeInput, { color: theme.ink, borderColor: theme.border, backgroundColor: theme.panel }]}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={pair}
        disabled={busy || code.trim().length < 6}
        style={[styles.button, { backgroundColor: theme.brand, opacity: busy || code.trim().length < 6 ? 0.5 : 1 }]}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Para tæki</Text>}
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Booking card
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  beidni: 'Beiðni',
  stadfest: 'Staðfest',
  maett: 'Mætt',
  lokid: 'Lokið',
  afbokad: 'Afbókað',
  ekki_maett: 'Mætti ekki',
};

function BookingCard({ booking, token, onChanged, theme }) {
  const [busy, setBusy] = useState(false);

  const act = async (adgerd) => {
    setBusy(true);
    try {
      await api(`/api/app/bokun/${booking.id}`, { token, method: 'POST', body: { adgerd } });
      onChanged();
    } catch (err) {
      Alert.alert('Aðgerð mistókst', err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmCancel = () => {
    Alert.alert('Afbóka tíma?', `${booking.vidskiptavinur.nafn} — ${booking.timi}`, [
      { text: 'Hætta við', style: 'cancel' },
      { text: 'Afbóka', style: 'destructive', onPress: () => act('afboka') },
    ]);
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.border }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.time, { color: theme.ink }]}>{booking.timi}</Text>
        <View style={[styles.badge, { backgroundColor: theme.brandSoft }]}>
          <Text style={[styles.badgeText, { color: theme.brand }]}>
            {STATUS_LABELS[booking.stada] ?? booking.stada}
          </Text>
        </View>
      </View>

      <Text style={[styles.customer, { color: theme.ink }]}>{booking.vidskiptavinur.nafn}</Text>
      <Text style={[styles.muted, { color: theme.muted }]}>
        {booking.thjonusta}
        {booking.starfsmadur ? ` · ${booking.starfsmadur}` : ''}
      </Text>

      {/* The intake answers — plate, symptoms, style — are what make this
          screen useful before the customer arrives. */}
      {booking.svor?.length > 0 && (
        <View style={[styles.answers, { borderTopColor: theme.border }]}>
          {booking.svor.map((answer, index) => (
            <Text key={index} style={[styles.answer, { color: theme.muted }]}>
              <Text style={{ fontWeight: '600', color: theme.ink }}>{answer.label}: </Text>
              {answer.value}
            </Text>
          ))}
        </View>
      )}

      {booking.athugasemd ? (
        <Text style={[styles.note, { color: theme.muted, borderTopColor: theme.border }]}>
          „{booking.athugasemd}“
        </Text>
      ) : null}

      <View style={styles.actions}>
        {booking.vidskiptavinur.simiE164 ? (
          <Pressable
            style={[styles.action, { borderColor: theme.border }]}
            onPress={() => Linking.openURL(`tel:${booking.vidskiptavinur.simiE164}`)}
          >
            <Text style={[styles.actionText, { color: theme.brand }]}>Hringja</Text>
          </Pressable>
        ) : null}

        {booking.stada === 'beidni' && (
          <Pressable style={[styles.action, { borderColor: theme.border }]} disabled={busy} onPress={() => act('stadfesta')}>
            <Text style={[styles.actionText, { color: theme.brand }]}>Staðfesta</Text>
          </Pressable>
        )}

        {booking.stada === 'stadfest' && (
          <Pressable style={[styles.action, { borderColor: theme.border }]} disabled={busy} onPress={() => act('maett')}>
            <Text style={[styles.actionText, { color: theme.brand }]}>Mætt</Text>
          </Pressable>
        )}

        {(booking.stada === 'maett' || booking.stada === 'stadfest') && (
          <Pressable style={[styles.action, { borderColor: theme.border }]} disabled={busy} onPress={() => act('lokid')}>
            <Text style={[styles.actionText, { color: theme.brand }]}>Lokið</Text>
          </Pressable>
        )}

        {booking.stada !== 'afbokad' && booking.stada !== 'lokid' && (
          <Pressable style={[styles.action, { borderColor: theme.border }]} disabled={busy} onPress={confirmCancel}>
            <Text style={[styles.actionText, { color: '#dc2626' }]}>Afbóka</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Diary screen
// ---------------------------------------------------------------------------

function DiaryScreen({ token, tenantName, onUnpair, theme }) {
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const result = await api('/api/app/yfirlit', { token });
      setData(result);
    } catch (err) {
      if (err.status === 401) {
        // The pairing was revoked from the control panel.
        await AsyncStorage.multiRemove([TOKEN_KEY, TENANT_KEY]);
        onUnpair();
        return;
      }
      setError(err.message);
    }
  }, [token, onUnpair]);

  useEffect(() => {
    load();
    // A booking can land at any time, so refresh periodically as a backstop
    // for a missed push notification.
    const timer = setInterval(load, 120_000);
    return () => clearInterval(timer);
  }, [load]);

  // Any tap on a notification should show the freshest diary.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(load);
    const received = Notifications.addNotificationReceivedListener(load);
    return () => {
      subscription.remove();
      received.remove();
    };
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!data) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={theme.brand} />}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.brand} />}
    >
      <Text style={[styles.header, { color: theme.ink }]}>{data.fyrirtaeki.nafn || tenantName}</Text>
      <Text style={[styles.muted, { color: theme.muted, marginBottom: 18 }]}>{data.dagur.texti}</Text>

      <View style={styles.stats}>
        {[
          { value: data.tolur.idag, label: 'Í dag' },
          { value: data.tolur.vikan, label: 'Vikan' },
          { value: data.tolur.framundan, label: 'Framundan' },
        ].map((stat) => (
          <View key={stat.label} style={[styles.stat, { backgroundColor: theme.panel, borderColor: theme.border }]}>
            <Text style={[styles.statValue, { color: theme.ink }]}>{stat.value}</Text>
            <Text style={[styles.muted, { color: theme.muted }]}>{stat.label}</Text>
          </View>
        ))}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {data.bokanir.length === 0 ? (
        <View style={[styles.card, { backgroundColor: theme.panel, borderColor: theme.border, alignItems: 'center' }]}>
          <Text style={[styles.muted, { color: theme.muted }]}>Engar bókanir í dag.</Text>
        </View>
      ) : (
        data.bokanir.map((booking) => (
          <BookingCard key={booking.id} booking={booking} token={token} onChanged={load} theme={theme} />
        ))
      )}

      <Pressable
        style={styles.unpair}
        onPress={() =>
          Alert.alert('Aftengja tæki?', 'Þú þarft nýjan pörunarkóða til að tengja aftur.', [
            { text: 'Hætta við', style: 'cancel' },
            {
              text: 'Aftengja',
              style: 'destructive',
              onPress: async () => {
                await AsyncStorage.multiRemove([TOKEN_KEY, TENANT_KEY]);
                onUnpair();
              },
            },
          ])
        }
      >
        <Text style={[styles.muted, { color: theme.muted }]}>Aftengja tæki</Text>
      </Pressable>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function App() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const theme = {
    bg: dark ? '#080d19' : '#f5f7fb',
    panel: dark ? '#111a2c' : '#ffffff',
    ink: dark ? '#e6ecf8' : '#0f172a',
    muted: dark ? '#94a3b8' : '#64748b',
    border: dark ? '#1e293b' : '#e2e8f0',
    brand: dark ? '#6ea8fe' : '#1d4ed8',
    brandSoft: dark ? '#16233c' : '#eff4ff',
  };

  const [token, setToken] = useState(null);
  const [tenantName, setTenantName] = useState('');
  const [ready, setReady] = useState(false);
  const refreshed = useRef(false);

  useEffect(() => {
    (async () => {
      const [[, storedToken], [, storedName]] = await AsyncStorage.multiGet([TOKEN_KEY, TENANT_KEY]);
      setToken(storedToken);
      setTenantName(storedName ?? '');
      setReady(true);
    })();
  }, []);

  // Push tokens rotate; refresh ours on every cold start so notifications
  // keep arriving after an OS update or app reinstall.
  useEffect(() => {
    if (!token || refreshed.current) return;
    refreshed.current = true;
    (async () => {
      try {
        const pushToken = await registerForPush();
        if (pushToken) {
          await api('/api/app/tilkynningar', { token, method: 'POST', body: { pushToken } });
        }
      } catch {
        // Non-fatal: the diary still works without push.
      }
    })();
  }, [token]);

  if (!ready) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.brand} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {token ? (
        <DiaryScreen
          token={token}
          tenantName={tenantName}
          theme={theme}
          onUnpair={() => {
            setToken(null);
            refreshed.current = false;
          }}
        />
      ) : (
        <PairingScreen
          theme={theme}
          onPaired={(newToken, name) => {
            setToken(newToken);
            setTenantName(name);
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  scroll: { padding: 16, paddingTop: 64, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: '800', marginBottom: 8 },
  header: { fontSize: 24, fontWeight: '700' },
  muted: { fontSize: 14 },
  error: { color: '#dc2626', marginVertical: 12, textAlign: 'center' },

  codeInput: {
    borderWidth: 1, borderRadius: 12, paddingVertical: 16, paddingHorizontal: 20,
    fontSize: 24, letterSpacing: 4, textAlign: 'center', width: '100%', marginBottom: 16,
  },
  button: { paddingVertical: 15, paddingHorizontal: 32, borderRadius: 12, width: '100%', alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  stats: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  stat: { flex: 1, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 24, fontWeight: '700' },

  card: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  time: { fontSize: 20, fontWeight: '700' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  customer: { fontSize: 16, fontWeight: '600' },

  answers: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, gap: 3 },
  answer: { fontSize: 13, lineHeight: 19 },
  note: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, fontStyle: 'italic', fontSize: 13 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  action: { borderWidth: 1, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 14 },
  actionText: { fontWeight: '600', fontSize: 14 },

  unpair: { alignItems: 'center', paddingVertical: 24 },
});

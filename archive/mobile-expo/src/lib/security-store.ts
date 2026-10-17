import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { storage } from './storage';

// Код-пароль и биометрия — локальная защита этого телефона (как в банковских приложениях).
// Хранится только солёный хэш кода, сам код никуда не уходит.

const PIN_KEY = 'gudex.pin';
const BIOMETRICS_KEY = 'gudex.biometrics';
const ATTEMPTS_KEY = 'gudex.pin.attempts';

export const PIN_LENGTH = 4;
export const MAX_PIN_ATTEMPTS = 5;

export type BiometryKind = 'faceId' | 'touchId' | 'fingerprint' | 'face' | 'biometrics';

interface StoredPin {
  salt: string;
  hash: string;
}

const hashPin = (pin: string, salt: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);

export async function hasPin(): Promise<boolean> {
  return (await storage.get(PIN_KEY)) !== null;
}

export async function savePin(pin: string): Promise<void> {
  const salt = Crypto.randomUUID();
  const stored: StoredPin = { salt, hash: await hashPin(pin, salt) };
  await storage.set(PIN_KEY, JSON.stringify(stored));
  await storage.remove(ATTEMPTS_KEY);
}

// Возвращает число оставшихся попыток: MAX — код верный, 0 — попытки кончились.
export async function checkPin(pin: string): Promise<{ ok: boolean; attemptsLeft: number }> {
  const raw = await storage.get(PIN_KEY);
  if (!raw) return { ok: false, attemptsLeft: 0 };
  const stored = JSON.parse(raw) as StoredPin;
  if ((await hashPin(pin, stored.salt)) === stored.hash) {
    await storage.remove(ATTEMPTS_KEY);
    return { ok: true, attemptsLeft: MAX_PIN_ATTEMPTS };
  }
  const failed = Number((await storage.get(ATTEMPTS_KEY)) ?? '0') + 1;
  await storage.set(ATTEMPTS_KEY, String(failed));
  return { ok: false, attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - failed) };
}

export async function isBiometricsEnabled(): Promise<boolean> {
  return (await storage.get(BIOMETRICS_KEY)) === 'on';
}

export async function setBiometricsEnabled(enabled: boolean): Promise<void> {
  await storage.set(BIOMETRICS_KEY, enabled ? 'on' : 'off');
}

export async function clearSecurity(): Promise<void> {
  await Promise.all([storage.remove(PIN_KEY), storage.remove(BIOMETRICS_KEY), storage.remove(ATTEMPTS_KEY)]);
}

// В Expo Go на iPhone Face ID недоступен (ограничение Expo Go) — заработает в установленной сборке.
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export async function detectBiometry(): Promise<{ kind: BiometryKind | null; faceIdBlockedInExpoGo: boolean }> {
  if (Platform.OS === 'web') return { kind: null, faceIdBlockedInExpoGo: false };
  const [hardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
  if (!hardware || !enrolled) return { kind: null, faceIdBlockedInExpoGo: false };
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  if (Platform.OS === 'ios') {
    if (face) return isExpoGo ? { kind: null, faceIdBlockedInExpoGo: true } : { kind: 'faceId', faceIdBlockedInExpoGo: false };
    return { kind: finger ? 'touchId' : null, faceIdBlockedInExpoGo: false };
  }
  if (finger) return { kind: 'fingerprint', faceIdBlockedInExpoGo: false };
  return { kind: face ? 'face' : 'biometrics', faceIdBlockedInExpoGo: false };
}

export async function authenticateWithBiometrics(promptMessage: string, cancelLabel: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel, disableDeviceFallback: true });
  return result.success;
}

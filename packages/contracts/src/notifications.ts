export interface WebPushPublicKeyResponse {
  enabled: boolean;
  publicKey: string | null;
  reason?: string;
}

export interface WebPushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface WebPushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: WebPushSubscriptionKeys;
}

export interface WebPushSubscriptionRecord {
  endpoint: string;
  expiration_time: string | null;
  user_agent: string | null;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

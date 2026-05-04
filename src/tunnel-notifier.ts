import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://iqfvfcncnvjbompqjhnh.supabase.co';
const supabaseAnonKey = 'sb_publishable_PMYuGKey4HCmxWP5vHuUmw_a7TQ_y1B';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

function normalizeTunnelUrl(url: string): string {
  if (url.startsWith('https://')) return url.replace('https://', 'wss://');
  if (url.startsWith('http://')) return url.replace('http://', 'ws://');
  return url;
}

export class TunnelNotifier {
  static async notifyTunnelUrl(
    deviceId: string,
    tunnelUrl: string,
    pairingCode?: string
  ): Promise<void> {
    const normalizedUrl = normalizeTunnelUrl(tunnelUrl);
    const maxRetries = 5;
    const delays = [1000, 2000, 4000, 8000, 16000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const upsertData: any = {
          device_id: deviceId,
          tunnel_url: normalizedUrl,
          provider: 'cloudflared',
          expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        };
        // Only set pairing_code when provided — don't overwrite existing code on tunnel restart
        if (pairingCode) {
          upsertData.pairing_code = pairingCode;
        }

        const { error } = await supabase.from('tunnel_sessions').upsert(
          upsertData,
          { onConflict: 'device_id' }
        );

        if (!error) {
          console.log('[TunnelNotifier] Tunnel URL notified to Supabase');
          return;
        }
        console.warn(`[TunnelNotifier] Attempt ${attempt + 1} failed: ${error.message}`);
      } catch (err: any) {
        console.warn(`[TunnelNotifier] Attempt ${attempt + 1} error: ${err.message}`);
      }

      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
    }
    console.error('[TunnelNotifier] All retries exhausted');
  }

  static async clearTunnelSession(deviceId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('tunnel_sessions')
        .delete()
        .eq('device_id', deviceId);

      if (error) {
        console.warn('[TunnelNotifier] Failed to clear tunnel session:', error.message);
      } else {
        console.log('[TunnelNotifier] Tunnel session cleared');
      }
    } catch (err: any) {
      console.warn('[TunnelNotifier] Error clearing tunnel session:', err.message);
    }
  }

  static async markTunnelOffline(deviceId: string): Promise<void> {
    try {
      const { error } = await supabase.from('tunnel_sessions').upsert({
        device_id: deviceId,
        tunnel_url: '',
        provider: 'cloudflared',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'device_id' });

      if (error) {
        console.warn('[TunnelNotifier] Failed to mark tunnel offline:', error.message);
      }
    } catch (err: any) {
      console.warn('[TunnelNotifier] Error marking tunnel offline:', err.message);
    }
  }
}

/**
 * Authentification "agents CCOLC".
 *
 * Modèle simple : un mot de passe partagé est vérifié côté Cloudflare Worker
 * (ou côté client en mode dev). En cas de succès, un token de session est
 * stocké dans localStorage (durée 8h).
 *
 * Sécurité : ce niveau d'auth est volontairement simple. Pour un usage
 * réellement sensible, basculer sur OAuth/SSO (hors scope CCOLC interne).
 */

import { CONFIG } from './config.js';

const STORAGE_KEY = 'frelon_ccolc_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8h

export class Auth {
  static getSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (Date.now() > session.expiresAt) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  static isAuthenticated() {
    return this.getSession() !== null;
  }

  static getToken() {
    return this.getSession()?.token ?? null;
  }

  static getAgentName() {
    return this.getSession()?.agentName ?? 'Agent CCOLC';
  }

  /**
   * Tente de se connecter via le Worker. Si pas de Worker configuré,
   * accepte n'importe quel mot de passe ≥ 4 caractères en mode dev local.
   */
  static async login({ password, agentName }) {
    if (!password || password.length < 4) {
      throw new Error('Mot de passe trop court (4 caractères minimum)');
    }

    let token;
    if (CONFIG.WORKER_URL) {
      const r = await fetch(`${CONFIG.WORKER_URL}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, agentName }),
      });
      if (!r.ok) {
        const msg = r.status === 401
          ? 'Mot de passe incorrect'
          : `Erreur serveur (${r.status})`;
        throw new Error(msg);
      }
      const data = await r.json();
      token = data.token;
    } else {
      // Mode dev local : on génère un faux token
      console.warn('[Auth] Mode dev local — pas de Worker configuré');
      token = 'dev-' + Math.random().toString(36).slice(2);
    }

    const session = {
      token,
      agentName: agentName || 'Agent CCOLC',
      expiresAt: Date.now() + SESSION_DURATION_MS,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  static logout() {
    localStorage.removeItem(STORAGE_KEY);
  }
}

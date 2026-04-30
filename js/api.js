/**
 * Couche d'accès aux données : Cloudflare Worker en prod,
 * localStorage en mode dev.
 *
 * Schéma d'un signalement :
 * {
 *   id: string (uuid),
 *   lat: number, lon: number,
 *   adresse: string,
 *   commune: string,
 *   codeInsee: string,
 *   typeObservation: 'vol' | 'butinage' | 'nid_visible' | 'activite_intense',
 *   nombreIndividus: '1-5' | '6-10' | '10+' | 'non_compte',
 *   commentaire: string,
 *   photoUrl: string|null,
 *   photoEspece: string,        // photo OBLIGATOIRE pour validation espèce
 *   statut: 'en_attente' | 'valide' | 'rejete' | 'nid_confirme',
 *   agentSignalant: string,
 *   dateCreation: string (ISO),
 *   dateValidation: string|null,
 *   agentValidateur: string|null,
 * }
 */

import { CONFIG } from './config.js';
import { Auth } from './auth.js';

const LOCAL_STORE_KEY = 'frelon_ccolc_signalements';

// ============= MODE LOCAL (dev / fallback) =============
class LocalStore {
  static _read() {
    try { return JSON.parse(localStorage.getItem(LOCAL_STORE_KEY)) || []; }
    catch { return []; }
  }
  static _write(list) {
    localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(list));
  }

  static async list() {
    return this._read();
  }

  static async create(signalement) {
    const all = this._read();
    const newSig = {
      ...signalement,
      id: crypto.randomUUID(),
      dateCreation: new Date().toISOString(),
      statut: 'en_attente',
      agentSignalant: Auth.getAgentName(),
    };
    all.push(newSig);
    this._write(all);
    return newSig;
  }

  static async update(id, patch) {
    const all = this._read();
    const idx = all.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('Signalement introuvable');
    all[idx] = { ...all[idx], ...patch };
    this._write(all);
    return all[idx];
  }

  static async delete(id) {
    const all = this._read().filter(s => s.id !== id);
    this._write(all);
  }
}

// ============= MODE WORKER (production) =============
class WorkerStore {
  static async _request(path, options = {}) {
    const token = Auth.getToken();
    const r = await fetch(`${CONFIG.WORKER_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (r.status === 401) {
      Auth.logout();
      throw new Error('Session expirée — veuillez vous reconnecter');
    }
    if (!r.ok) {
      const msg = await r.text().catch(() => '');
      throw new Error(`Erreur API (${r.status}) : ${msg || r.statusText}`);
    }
    return r.json();
  }

  static list() { return this._request('/signalements'); }
  static create(s) { return this._request('/signalements', { method: 'POST', body: JSON.stringify(s) }); }
  static update(id, patch) { return this._request(`/signalements/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); }
  static delete(id) { return this._request(`/signalements/${id}`, { method: 'DELETE' }); }
}

// ============= API exportée =============
function _store() {
  return CONFIG.WORKER_URL ? WorkerStore : LocalStore;
}

export const Api = {
  /** Liste tous les signalements (filtrage par fraîcheur côté UI). */
  list: () => _store().list(),

  /** Crée un nouveau signalement (statut initial : en_attente). */
  create: (signalement) => _store().create(signalement),

  /** Met à jour partiellement un signalement (validation, rejet, etc.). */
  update: (id, patch) => _store().update(id, patch),

  /** Supprime un signalement (admin uniquement, doit aussi être archivé). */
  delete: (id) => _store().delete(id),

  /**
   * Filtre les signalements pour ne garder que les "actifs" :
   * statut validé/nid_confirmé ET dans les 30 derniers jours.
   */
  filterActifs(signalements) {
    const seuil = Date.now() - CONFIG.DUREE_VALIDITE_JOURS * 86400_000;
    return signalements.filter(s =>
      (s.statut === 'valide' || s.statut === 'nid_confirme') &&
      new Date(s.dateCreation).getTime() >= seuil
    );
  },

  filterEnAttente(signalements) {
    return signalements.filter(s => s.statut === 'en_attente');
  },
};

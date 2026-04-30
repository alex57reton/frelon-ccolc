/**
 * Interface super-agent : validation des photos en attente.
 *
 * Auth distincte de l'app principale : on utilise une clé localStorage
 * dédiée 'frelon_ccolc_admin_session' pour qu'un agent simple connecté
 * sur index.html ne devienne pas admin par effet de bord.
 */

import { CONFIG } from './config.js';

const ADMIN_STORAGE_KEY = 'frelon_ccolc_admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

// ============= Auth admin =============

const AdminAuth = {
  getSession() {
    try {
      const raw = localStorage.getItem(ADMIN_STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (Date.now() > s.expiresAt) {
        localStorage.removeItem(ADMIN_STORAGE_KEY);
        return null;
      }
      return s;
    } catch { return null; }
  },
  isAuthenticated() { return this.getSession() !== null; },
  getToken() { return this.getSession()?.token ?? null; },
  getAgentName() { return this.getSession()?.agentName ?? 'Super-agent'; },

  async login({ password, agentName }) {
    if (!password || password.length < 4) {
      throw new Error('Mot de passe trop court');
    }
    if (!CONFIG.WORKER_URL) {
      throw new Error('Worker non configuré (mode dev impossible pour l\'admin)');
    }
    const r = await fetch(`${CONFIG.WORKER_URL}/admin/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, agentName }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `Erreur ${r.status}`);
    }
    const data = await r.json();
    const session = {
      token: data.token,
      agentName: agentName || 'Super-agent',
      expiresAt: Date.now() + SESSION_DURATION_MS,
    };
    localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(session));
    return session;
  },

  logout() { localStorage.removeItem(ADMIN_STORAGE_KEY); },
};

// ============= API admin =============

async function apiCall(path, options = {}) {
  const r = await fetch(`${CONFIG.WORKER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AdminAuth.getToken()}`,
      ...(options.headers || {}),
    },
  });
  if (r.status === 401 || r.status === 403) {
    AdminAuth.logout();
    location.reload();
    throw new Error('Session expirée');
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `Erreur ${r.status}`);
  }
  return r.json();
}

// ============= Vue principale =============

class ValidationApp {
  constructor() {
    this.signalements = [];
  }

  async start() {
    if (!AdminAuth.isAuthenticated()) {
      this.showAuthModal();
      return;
    }
    document.getElementById('admin-name').textContent = AdminAuth.getAgentName();
    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('Se déconnecter ?')) {
        AdminAuth.logout();
        location.reload();
      }
    });
    document.getElementById('refresh-btn').addEventListener('click', () => this.refresh());
    await this.refresh();
  }

  showAuthModal() {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="admin-auth-modal">
        <div class="modal">
          <h2 class="modal__title">Connexion super-agent</h2>
          <p class="modal__subtitle">
            Accès réservé à la validation des signalements.
            Mot de passe distinct de l'application principale.
          </p>
          <form id="admin-auth-form">
            <div class="form-row">
              <label for="admin-agent-name">Votre nom</label>
              <input type="text" id="admin-agent-name" required placeholder="Prénom Nom">
            </div>
            <div class="form-row">
              <label for="admin-password">Mot de passe administrateur</label>
              <input type="password" id="admin-password" required>
            </div>
            <div id="admin-auth-error" style="color:#b91c1c;font-size:0.85rem;
                 margin-bottom:12px;min-height:1.2em;"></div>
            <button type="submit" class="btn btn--primary" id="admin-auth-submit">
              Accéder à la validation
            </button>
          </form>
        </div>
      </div>
    `);

    document.getElementById('admin-auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = document.getElementById('admin-auth-submit');
      const err = document.getElementById('admin-auth-error');
      submit.disabled = true;
      submit.innerHTML = '<span class="spinner"></span> Connexion...';
      err.textContent = '';
      try {
        await AdminAuth.login({
          password: document.getElementById('admin-password').value,
          agentName: document.getElementById('admin-agent-name').value.trim(),
        });
        document.getElementById('admin-auth-modal').remove();
        this.start();
      } catch (e) {
        err.textContent = e.message;
        submit.disabled = false;
        submit.textContent = 'Accéder à la validation';
      }
    });
    document.getElementById('admin-agent-name').focus();
  }

  async refresh() {
    const list = document.getElementById('signalements-list');
    const count = document.getElementById('count');
    list.innerHTML = '<div class="val-empty"><div class="val-empty__icon">⏳</div>'
                   + '<div class="val-empty__msg">Chargement...</div></div>';
    try {
      this.signalements = await apiCall('/admin/en-attente');
      count.innerHTML = this.signalements.length
        ? `<strong>${this.signalements.length}</strong> signalement${this.signalements.length > 1 ? 's' : ''} en attente`
        : 'Aucun signalement en attente';
      this.render();
    } catch (e) {
      list.innerHTML = `<div class="val-error">
        <strong>Erreur :</strong> ${escapeHtml(e.message)}
      </div>`;
    }
  }

  render() {
    const list = document.getElementById('signalements-list');
    if (this.signalements.length === 0) {
      list.innerHTML = `
        <div class="val-empty">
          <div class="val-empty__icon">✓</div>
          <div class="val-empty__msg">Aucun signalement en attente</div>
          <div class="val-empty__sub">Tout est à jour. Les nouveaux signalements apparaîtront ici.</div>
        </div>
      `;
      return;
    }
    list.innerHTML = `<div class="val-grid">${
      this.signalements.map(s => this.renderCard(s)).join('')
    }</div>`;

    // Attach event listeners
    list.querySelectorAll('[data-action="zoom"]').forEach(el => {
      el.addEventListener('click', () => this.openLightbox(el.dataset.src));
    });
    list.querySelectorAll('[data-action="valider"]').forEach(el => {
      el.addEventListener('click', () => this.valider(el.dataset.id));
    });
    list.querySelectorAll('[data-action="rejeter"]').forEach(el => {
      el.addEventListener('click', () => this.rejeter(el.dataset.id));
    });
  }

  renderCard(s) {
    const ageMs = Date.now() - new Date(s.dateCreation).getTime();
    const ageHours = Math.floor(ageMs / 3600_000);
    const ageDays = Math.floor(ageHours / 24);
    const ageLabel = ageDays >= 1
      ? `il y a ${ageDays} j`
      : `il y a ${ageHours} h`;
    const isUrgent = ageDays >= 3;

    const types = {
      vol: 'Vol de frelons',
      butinage: 'Butinage',
      nid_visible: 'Nid visible',
      activite_intense: 'Activité intense',
    };

    return `
      <article class="val-card ${isUrgent ? 'urgent' : ''}">
        <div class="val-card__photo" data-action="zoom" data-src="${s.photoEspece}">
          <img src="${s.photoEspece}" alt="Photo de validation espèce" loading="lazy">
          <div class="val-card__photo-zoom">🔍 Agrandir</div>
        </div>
        <div class="val-card__body">
          <div class="val-card__header">
            <div class="val-card__commune">${escapeHtml(s.commune || '?')}</div>
            <div class="val-card__age ${isUrgent ? 'val-card__age--urgent' : ''}">
              ${ageLabel}
            </div>
          </div>
          <div class="val-card__adresse">${escapeHtml(s.adresse)}</div>
          <dl class="val-card__meta">
            <dt>Type</dt><dd>${types[s.typeObservation] || s.typeObservation}</dd>
            <dt>Nombre</dt><dd>${escapeHtml(s.nombreIndividus)}</dd>
            <dt>Agent</dt><dd>${escapeHtml(s.agentSignalant || '?')}</dd>
            <dt>Date</dt><dd>${new Date(s.dateCreation).toLocaleString('fr-FR', {
              dateStyle: 'short', timeStyle: 'short',
            })}</dd>
          </dl>
          ${s.commentaire ? `
            <div class="val-card__commentaire">"${escapeHtml(s.commentaire)}"</div>
          ` : ''}
          <div class="val-card__actions">
            <button class="btn btn--validate" data-action="valider" data-id="${s.id}">
              ✓ Valider
            </button>
            <button class="btn btn--reject" data-action="rejeter" data-id="${s.id}">
              ✗ Rejeter
            </button>
          </div>
        </div>
      </article>
    `;
  }

  async valider(id) {
    const sig = this.signalements.find(s => s.id === id);
    if (!sig) return;
    if (!confirm(`Confirmer la validation de "${sig.commune}" ?\n\nLe signalement apparaîtra sur la carte avec son cercle de 700m.`)) return;
    try {
      await apiCall(`/admin/signalements/${id}/valider`, { method: 'POST' });
      this.signalements = this.signalements.filter(s => s.id !== id);
      this.render();
      document.getElementById('count').innerHTML = this.signalements.length
        ? `<strong>${this.signalements.length}</strong> signalement${this.signalements.length > 1 ? 's' : ''} en attente`
        : 'Aucun signalement en attente';
      toast(`✓ Signalement validé`, 'success');
    } catch (e) {
      toast('Erreur : ' + e.message, 'error');
    }
  }

  async rejeter(id) {
    const sig = this.signalements.find(s => s.id === id);
    if (!sig) return;
    const motif = prompt(
      `Rejeter le signalement de "${sig.commune}" ?\n\nMotif (optionnel — sera consigné dans le registre permanent) :`
    );
    if (motif === null) return; // annulation

    try {
      await apiCall(`/admin/signalements/${id}/rejeter`, {
        method: 'POST',
        body: JSON.stringify({ motif }),
      });
      this.signalements = this.signalements.filter(s => s.id !== id);
      this.render();
      document.getElementById('count').innerHTML = this.signalements.length
        ? `<strong>${this.signalements.length}</strong> signalement${this.signalements.length > 1 ? 's' : ''} en attente`
        : 'Aucun signalement en attente';
      toast('Signalement rejeté', 'success');
    } catch (e) {
      toast('Erreur : ' + e.message, 'error');
    }
  }

  openLightbox(src) {
    const html = `
      <div class="lightbox" id="lightbox">
        <button class="lightbox__close">&times;</button>
        <img src="${src}" alt="Photo agrandie">
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const lb = document.getElementById('lightbox');
    lb.addEventListener('click', () => lb.remove());
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        lb.remove();
        document.removeEventListener('keydown', esc);
      }
    });
  }
}

// ============= Toast =============

function toast(msg, type = 'info', duration = 3500) {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, duration);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  new ValidationApp().start();
});

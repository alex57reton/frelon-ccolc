/**
 * Orchestrateur principal de l'application Frelon CCOLC.
 */

import { CONFIG } from './config.js';
import { Auth } from './auth.js';
import { Api } from './api.js';
import {
  searchAddress,
  reverseGeocode,
  isInCcolc,
  calculerZonesConfiance,
} from './geo.js';
import { MapView } from './map.js';

class App {
  constructor() {
    this.mapView = null;
    this.ccolcGeojson = null;
    this.signalements = [];
    this.pendingSignalement = null; // données en cours de saisie
    this.photoEspeceData = null;     // base64 de la photo obligatoire
  }

  async start() {
    // 1. Vérifier auth
    if (!Auth.isAuthenticated()) {
      this._showAuthModal();
      return;
    }
    this._renderHeaderUser();

    // 2. Initialiser carte
    this.mapView = new MapView('map');
    this.mapView.onMapClick((latlng) => this._handleMapClick(latlng));

    // 3. Charger périmètre CCOLC
    await this._loadCcolcPerimeter();

    // 4. Charger signalements
    await this._refreshSignalements();

    // 5. Initialiser formulaire
    this._setupForm();
    this._setupLogout();

    // 6. Refresh périodique des signalements
    setInterval(() => this._refreshSignalements(), 60_000);
  }

  // ============= AUTH =============

  _showAuthModal() {
    const html = `
      <div class="modal-backdrop" id="auth-modal">
        <div class="modal">
          <h2 class="modal__title">Connexion agent CCOLC</h2>
          <p class="modal__subtitle">
            Outil interne réservé aux agents de la CC Orne Lorraine Confluences.
          </p>
          <form id="auth-form">
            <div class="form-row">
              <label for="agent-name">Votre nom (pour traçabilité)</label>
              <input type="text" id="agent-name" required autocomplete="name"
                     placeholder="Prénom Nom">
            </div>
            <div class="form-row">
              <label for="auth-password">Mot de passe agent</label>
              <input type="password" id="auth-password" required autocomplete="current-password">
            </div>
            <div id="auth-error" style="color:#b91c1c;font-size:0.85rem;
                 margin-bottom:12px;min-height:1.2em;"></div>
            <button type="submit" class="btn btn--primary" id="auth-submit">
              Se connecter
            </button>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = document.getElementById('auth-submit');
      const errorEl = document.getElementById('auth-error');
      submit.disabled = true;
      submit.innerHTML = '<span class="spinner"></span> Connexion...';
      errorEl.textContent = '';

      try {
        await Auth.login({
          password: document.getElementById('auth-password').value,
          agentName: document.getElementById('agent-name').value.trim(),
        });
        document.getElementById('auth-modal').remove();
        this.start();
      } catch (err) {
        errorEl.textContent = err.message;
        submit.disabled = false;
        submit.textContent = 'Se connecter';
      }
    });

    document.getElementById('agent-name').focus();
  }

  _renderHeaderUser() {
    const el = document.getElementById('agent-display');
    if (el) el.textContent = Auth.getAgentName();
  }

  _setupLogout() {
    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('Se déconnecter ?')) {
        Auth.logout();
        location.reload();
      }
    });
  }

  // ============= PÉRIMÈTRE CCOLC =============

  async _loadCcolcPerimeter() {
    try {
      // Tente de charger le fichier statique
      const r = await fetch(CONFIG.GEOJSON_PATH);
      if (r.ok) {
        this.ccolcGeojson = await r.json();
        this.mapView.drawCcolcPerimeter(this.ccolcGeojson);
        this.mapView.fitToCcolc(this.ccolcGeojson);
        return;
      }
      throw new Error('GeoJSON statique absent');
    } catch (err) {
      // Fallback : on charge depuis l'API live (plus lent au premier load)
      console.warn('[CCOLC] Fallback API live :', err.message);
      this._toast(
        'Périmètre CCOLC chargé en mode fallback (lancez le script generate_ccolc_geojson.py pour optimiser)',
        'warn',
        7000
      );
      await this._loadCcolcFromApi();
    }
  }

  async _loadCcolcFromApi() {
    const codes = [
      '54028','54002','54004','54009','54018','54036','54048','54051',
      '54058','54066','54082','54093','54103','54136','54171','54198',
      '54213','54227','54231','54253','54263','54273','54277','54280',
      '54283','54286','54302','54326','54371','54389','54391','54402',
      '54408','54413','54440','54469','54478','54524','54099','54542',
      '54581',
    ];
    const features = [];
    // On parallélise par paquets de 10
    for (let i = 0; i < codes.length; i += 10) {
      const batch = codes.slice(i, i + 10);
      const results = await Promise.all(batch.map(async code => {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes/${code}` +
          `?fields=nom,code,population,contour&format=geojson&geometry=contour`
        );
        return r.ok ? r.json() : null;
      }));
      results.filter(Boolean).forEach(f => features.push(f));
    }
    this.ccolcGeojson = { type: 'FeatureCollection', features };
    this.mapView.drawCcolcPerimeter(this.ccolcGeojson);
    this.mapView.fitToCcolc(this.ccolcGeojson);
  }

  // ============= SIGNALEMENTS =============

  async _refreshSignalements() {
    try {
      this.signalements = await Api.list();
      this._renderSignalements();
      this._renderStats();
    } catch (err) {
      console.error('[Signalements]', err);
      this._toast('Erreur chargement signalements : ' + err.message, 'error');
    }
  }

  _renderSignalements() {
    this.mapView.clearSignalements();
    this.mapView.clearZones();

    const actifs = Api.filterActifs(this.signalements);
    const enAttente = Api.filterEnAttente(this.signalements);

    actifs.forEach(s => this.mapView.drawSignalement(s));
    enAttente.forEach(s => this.mapView.drawEnAttente(s));

    // Triangulation
    const zones = calculerZonesConfiance(actifs);
    zones.forEach(z => this.mapView.drawZone(z));
  }

  _renderStats() {
    const actifs = Api.filterActifs(this.signalements);
    const enAttente = Api.filterEnAttente(this.signalements);
    const nids = actifs.filter(s => s.statut === 'nid_confirme');
    const zones = calculerZonesConfiance(actifs);

    document.getElementById('stat-actifs').textContent = actifs.length;
    document.getElementById('stat-attente').textContent = enAttente.length;
    document.getElementById('stat-nids').textContent = nids.length;
    document.getElementById('stat-zones').textContent = zones.length;
  }

  // ============= FORMULAIRE =============

  _setupForm() {
    const form = document.getElementById('signalement-form');
    const adresseInput = document.getElementById('adresse-input');
    const autocompleteList = document.getElementById('autocomplete-list');
    const photoInput = document.getElementById('photo-espece');
    const photoWrap = document.getElementById('photo-espece-wrap');
    const photoLabel = document.getElementById('photo-espece-label');
    const photoPreview = document.getElementById('photo-espece-preview');

    // --- Autocomplete BAN
    let lastResults = [];
    adresseInput.addEventListener('input', async () => {
      const q = adresseInput.value.trim();
      if (q.length < 3) {
        autocompleteList.style.display = 'none';
        return;
      }
      const results = await searchAddress(q);
      lastResults = results;
      this._renderAutocomplete(results, autocompleteList, adresseInput);
    });
    adresseInput.addEventListener('blur', () => {
      setTimeout(() => { autocompleteList.style.display = 'none'; }, 200);
    });
    adresseInput.addEventListener('focus', () => {
      if (lastResults.length) autocompleteList.style.display = 'block';
    });

    // --- Photo upload
    photoInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        this._toast('Photo trop lourde (max 5 Mo)', 'error');
        photoInput.value = '';
        return;
      }
      const dataUrl = await this._fileToDataUrl(file);
      this.photoEspeceData = dataUrl;
      photoWrap.classList.add('file-input-wrap--filled');
      photoLabel.textContent = `✓ ${file.name}`;
      photoPreview.src = dataUrl;
      photoPreview.style.display = 'block';
    });

    // --- Submit
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submitSignalement();
    });
  }

  _renderAutocomplete(results, listEl, inputEl) {
    if (!results.length) {
      listEl.style.display = 'none';
      return;
    }
    listEl.innerHTML = results.map((r, i) => `
      <div class="autocomplete-item" data-i="${i}">
        ${escapeHtml(r.label)}
        <span class="autocomplete-item__commune">
          ${escapeHtml(r.commune)} · ${r.codeInsee}
        </span>
      </div>
    `).join('');
    listEl.style.display = 'block';

    listEl.querySelectorAll('.autocomplete-item').forEach(el => {
      el.addEventListener('mousedown', () => {
        const r = results[+el.dataset.i];
        inputEl.value = r.label;
        listEl.style.display = 'none';
        this._setPendingFromBan(r);
      });
    });
  }

  _setPendingFromBan(r) {
    this.pendingSignalement = {
      adresse: r.label,
      lat: r.lat,
      lon: r.lon,
      commune: r.commune,
      codeInsee: r.codeInsee,
    };
    this._validatePendingLocation();
    this.mapView.setPreviewMarker(r.lat, r.lon);
    this.mapView.flyTo(r.lat, r.lon, 15);
  }

  async _handleMapClick(latlng) {
    const reverse = await reverseGeocode(latlng.lat, latlng.lng);
    if (!reverse) {
      this._toast('Adresse introuvable à ce point', 'error');
      return;
    }
    document.getElementById('adresse-input').value = reverse.label;
    this._setPendingFromBan(reverse);
  }

  _validatePendingLocation() {
    if (!this.pendingSignalement) return false;
    const ok = isInCcolc(this.pendingSignalement, this.ccolcGeojson);
    if (!ok) {
      this._toast(
        `❌ Cette adresse (${this.pendingSignalement.commune}) ` +
        `n'est pas dans le périmètre CCOLC. Signalement refusé.`,
        'error', 6000
      );
      this.mapView.clearPreview();
      this.pendingSignalement = null;
      document.getElementById('adresse-input').value = '';
      return false;
    }
    return true;
  }

  async _submitSignalement() {
    if (!this.pendingSignalement) {
      this._toast('Veuillez sélectionner une adresse dans la liste', 'error');
      return;
    }
    if (!this._validatePendingLocation()) return;
    if (!this.photoEspeceData) {
      this._toast('Photo de validation espèce obligatoire', 'error');
      return;
    }

    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Enregistrement...';

    const data = {
      ...this.pendingSignalement,
      typeObservation: document.getElementById('type-observation').value,
      nombreIndividus: document.getElementById('nombre-individus').value,
      commentaire: document.getElementById('commentaire').value.trim(),
      photoEspece: this.photoEspeceData,
      photoUrl: null,
    };

    try {
      await Api.create(data);
      this._toast(
        '✓ Signalement enregistré. Statut : en attente de validation.',
        'success'
      );
      this._resetForm();
      await this._refreshSignalements();
    } catch (err) {
      this._toast('Erreur : ' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Enregistrer le signalement';
    }
  }

  _resetForm() {
    document.getElementById('signalement-form').reset();
    document.getElementById('photo-espece-wrap')
      .classList.remove('file-input-wrap--filled');
    document.getElementById('photo-espece-label').textContent =
      'Cliquez pour ajouter une photo (obligatoire)';
    document.getElementById('photo-espece-preview').style.display = 'none';
    this.pendingSignalement = null;
    this.photoEspeceData = null;
    this.mapView.clearPreview();
  }

  // ============= UTILS =============

  _fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
  }

  _toast(msg, type = 'info', duration = 4000) {
    const stack = document.getElementById('toast-stack');
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, duration);
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============= BOOTSTRAP =============

document.addEventListener('DOMContentLoaded', () => {
  new App().start();
});

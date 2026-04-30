/**
 * Gestion de la carte Leaflet : tuiles, périmètre CCOLC, signalements,
 * cercles de vol 700m, zones de triangulation.
 */

import { CONFIG } from './config.js';
import { COULEURS_CONFIANCE } from './geo.js';

export class MapView {
  constructor(elementId) {
    this.map = L.map(elementId, {
      center: CONFIG.CARTE_CENTRE,
      zoom: CONFIG.CARTE_ZOOM,
      minZoom: 9,
      zoomControl: true,
    });

    this._setupTiles();

    // Couches dynamiques (ordre = z-index visuel)
    this.layerCcolc        = L.layerGroup().addTo(this.map);
    this.layerCercles      = L.layerGroup().addTo(this.map);
    this.layerZones        = L.layerGroup().addTo(this.map);
    this.layerSignalements = L.layerGroup().addTo(this.map);
    this.layerEnAttente    = L.layerGroup().addTo(this.map);

    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);

    this._clickHandlers = [];
    this.map.on('click', (e) => {
      this._clickHandlers.forEach(h => h(e.latlng));
    });
  }

  _setupTiles() {
    const osm   = L.tileLayer(CONFIG.TUILES.osm.url, CONFIG.TUILES.osm);
    const light = L.tileLayer(CONFIG.TUILES.light.url, CONFIG.TUILES.light);
    const sat   = L.tileLayer(CONFIG.TUILES.sat.url, CONFIG.TUILES.sat);
    light.addTo(this.map);

    L.control.layers(
      { 'Plan clair': light, 'OpenStreetMap': osm, 'Satellite': sat },
      null,
      { position: 'topright', collapsed: true }
    ).addTo(this.map);
  }

  /** Enregistre un handler appelé à chaque clic sur la carte. */
  onMapClick(handler) {
    this._clickHandlers.push(handler);
  }

  /** Affiche le périmètre CCOLC (GeoJSON des 41 communes). */
  drawCcolcPerimeter(geojson) {
    this.layerCcolc.clearLayers();
    L.geoJSON(geojson, {
      style: {
        color: '#1a1815',
        weight: 1.2,
        fillColor: '#d97706',
        fillOpacity: 0.04,
        dashArray: '4 3',
      },
      onEachFeature: (feature, layer) => {
        const nom = feature.properties?.nom || '?';
        const pop = feature.properties?.population;
        layer.bindTooltip(
          nom + (pop ? ` — ${pop.toLocaleString('fr')} hab.` : ''),
          { sticky: true }
        );
      },
    }).addTo(this.layerCcolc);
  }

  /** Recentre la carte sur le périmètre CCOLC. */
  fitToCcolc(geojson) {
    const layer = L.geoJSON(geojson);
    const bounds = layer.getBounds();
    if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [20, 20] });
  }

  /** Efface tous les signalements affichés. */
  clearSignalements() {
    this.layerSignalements.clearLayers();
    this.layerCercles.clearLayers();
    this.layerEnAttente.clearLayers();
  }

  clearZones() {
    this.layerZones.clearLayers();
  }

  /** Affiche un signalement validé (cercle 700m + marqueur). */
  drawSignalement(s, { onClick } = {}) {
    const couleur = s.statut === 'nid_confirme' ? '#1a1815' : '#475569';

    // Cercle de vol 700m
    L.circle([s.lat, s.lon], {
      radius: CONFIG.RAYON_VOL_METRES,
      color: couleur,
      weight: 1,
      opacity: 0.6,
      fillColor: couleur,
      fillOpacity: 0.06,
    }).addTo(this.layerCercles);

    // Marqueur
    const isNid = s.statut === 'nid_confirme';
    const icon = L.divIcon({
      className: 'frelon-marker',
      html: `<div class="marker-pin marker-pin--${isNid ? 'nid' : 'sig'}">
               <span>${isNid ? '⬣' : '●'}</span>
             </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const marker = L.marker([s.lat, s.lon], { icon })
      .addTo(this.layerSignalements)
      .bindPopup(this._popupHtml(s));

    if (onClick) marker.on('click', () => onClick(s));
    return marker;
  }

  /** Affiche un signalement en attente de validation (gris, sans cercle). */
  drawEnAttente(s, { onClick } = {}) {
    const icon = L.divIcon({
      className: 'frelon-marker',
      html: `<div class="marker-pin marker-pin--attente">
               <span>?</span>
             </div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });

    const marker = L.marker([s.lat, s.lon], { icon })
      .addTo(this.layerEnAttente)
      .bindPopup(this._popupHtml(s));

    if (onClick) marker.on('click', () => onClick(s));
    return marker;
  }

  /** Affiche une zone de confiance (intersection de cercles). */
  drawZone(zone) {
    const { color, label } = COULEURS_CONFIANCE[zone.niveau];

    // Cercle visuel pour matérialiser la zone (rayon plus petit = plus précis)
    const rayon = Math.max(80, 250 - zone.nbSignalements * 20);
    L.circle([zone.lat, zone.lon], {
      radius: rayon,
      color,
      weight: 2.5,
      fillColor: color,
      fillOpacity: 0.35,
    }).addTo(this.layerZones).bindPopup(`
      <h4>⚠ Zone de présence potentielle de nid</h4>
      <p style="margin:6px 0 8px;font-size:0.86rem;line-height:1.5;color:var(--ink-soft);">
        Recoupement de signalements : un nid de <em>Vespa velutina</em>
        est probablement situé dans cette zone.
      </p>
      <dl>
        <dt>Niveau de confiance</dt><dd>${label}</dd>
        <dt>Signalements croisés</dt><dd>${zone.nbSignalements}</dd>
        <dt>Action recommandée</dt><dd>Inspection visuelle à privilégier</dd>
      </dl>
    `);

    // Marqueur cible au centre
    const icon = L.divIcon({
      className: 'frelon-marker',
      html: `<div class="marker-pin marker-pin--zone" style="--c:${color}">
               <span>⊕</span>
             </div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    L.marker([zone.lat, zone.lon], { icon, zIndexOffset: 1000 })
      .addTo(this.layerZones)
      .bindTooltip(`Présence potentielle de nid · ${label}`, {
        sticky: true,
        direction: 'top',
        offset: [0, -10],
      });
  }

  _popupHtml(s) {
    const date = new Date(s.dateCreation).toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const ageJours = Math.floor(
      (Date.now() - new Date(s.dateCreation).getTime()) / 86400_000
    );

    const types = {
      vol: 'Vol de frelons',
      butinage: 'Butinage',
      nid_visible: 'Nid visible',
      activite_intense: 'Activité intense',
    };

    const photoSection = s.photoEspece
      ? `<img src="${s.photoEspece}" style="max-width:200px;max-height:140px;
           margin-top:8px;border-radius:2px;display:block;" alt="Validation espèce">`
      : '';

    return `
      <h4>Signalement</h4>
      <dl>
        <dt>Adresse</dt><dd>${escapeHtml(s.adresse)}</dd>
        <dt>Commune</dt><dd>${escapeHtml(s.commune || '?')}</dd>
        <dt>Type</dt><dd>${types[s.typeObservation] || s.typeObservation}</dd>
        <dt>Nombre</dt><dd>${s.nombreIndividus}</dd>
        <dt>Date</dt><dd>${date} (${ageJours}j)</dd>
        <dt>Agent</dt><dd>${escapeHtml(s.agentSignalant)}</dd>
        <dt>Statut</dt><dd>${labelStatut(s.statut)}</dd>
        ${s.commentaire ? `<dt>Note</dt><dd>${escapeHtml(s.commentaire)}</dd>` : ''}
      </dl>
      ${photoSection}
    `;
  }

  /** Centre sur un point avec animation. */
  flyTo(lat, lon, zoom = 16) {
    this.map.flyTo([lat, lon], zoom, { duration: 0.7 });
  }

  /** Marqueur temporaire pour preview avant soumission. */
  setPreviewMarker(lat, lon) {
    this.clearPreview();
    const icon = L.divIcon({
      className: 'frelon-marker',
      html: `<div class="marker-pin marker-pin--preview"><span>+</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    this._previewMarker = L.marker([lat, lon], { icon, zIndexOffset: 2000 })
      .addTo(this.map);
    this._previewCircle = L.circle([lat, lon], {
      radius: CONFIG.RAYON_VOL_METRES,
      color: '#d97706',
      weight: 2,
      dashArray: '5 5',
      fillColor: '#d97706',
      fillOpacity: 0.08,
    }).addTo(this.map);
  }

  clearPreview() {
    if (this._previewMarker) this.map.removeLayer(this._previewMarker);
    if (this._previewCircle) this.map.removeLayer(this._previewCircle);
    this._previewMarker = null;
    this._previewCircle = null;
  }
}

// ============= Helpers =============

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function labelStatut(s) {
  return {
    en_attente: 'En attente de validation',
    valide: 'Validé',
    rejete: 'Rejeté',
    nid_confirme: 'Nid confirmé',
  }[s] || s;
}

/**
 * Module géographique :
 *   - Géocodage / autocomplétion via Base Adresse Nationale (BAN)
 *   - Validation qu'un point est dans le périmètre CCOLC
 *   - Calcul des cercles de vol (700m) et de leurs intersections
 *
 * Calculs métriques : on convertit lat/lon → projection Web Mercator (EPSG:3857)
 * approximative pour les calculs de distance courte, ce qui est suffisant
 * à l'échelle d'une commune. Pour des distances plus précises on utiliserait
 * Lambert 93 (EPSG:2154) — mais Turf.js donne déjà une précision excellente
 * via formules géodésiques sur sphère.
 */

import { CONFIG, COMMUNES_CCOLC_INSEE } from './config.js';

// ============= Géocodage BAN =============

let _debounceTimer = null;

/**
 * Recherche d'adresses via la BAN avec debounce.
 * Renvoie une promesse de tableau [{ label, lat, lon, codeInsee, commune }].
 */
export function searchAddress(query) {
  return new Promise((resolve) => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(async () => {
      if (!query || query.length < 3) return resolve([]);
      try {
        // Bounding box CCOLC pour biaiser la recherche
        const [[minLat, minLon], [maxLat, maxLon]] = CONFIG.CARTE_BBOX;
        const url = new URL(CONFIG.BAN_URL);
        url.searchParams.set('q', query);
        url.searchParams.set('limit', CONFIG.BAN_LIMIT);
        // Centre approximatif CCOLC pour pondérer
        url.searchParams.set('lat', '49.21');
        url.searchParams.set('lon', '5.94');

        const r = await fetch(url);
        const data = await r.json();
        const results = (data.features || [])
          .map(f => ({
            label: f.properties.label,
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            codeInsee: f.properties.citycode,
            commune: f.properties.city,
            postcode: f.properties.postcode,
          }))
          // On filtre pour ne montrer que les résultats dans la bbox élargie
          .filter(r =>
            r.lat >= minLat - 0.05 && r.lat <= maxLat + 0.05 &&
            r.lon >= minLon - 0.1 && r.lon <= maxLon + 0.1
          );
        resolve(results);
      } catch (err) {
        console.error('[BAN] erreur', err);
        resolve([]);
      }
    }, CONFIG.BAN_DEBOUNCE_MS);
  });
}

/** Géocodage inverse : coords → adresse (utilisé pour clic sur carte). */
export async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}`;
    const r = await fetch(url);
    const data = await r.json();
    const f = data.features?.[0];
    if (!f) return null;
    return {
      label: f.properties.label,
      codeInsee: f.properties.citycode,
      commune: f.properties.city,
      postcode: f.properties.postcode,
      lat, lon,
    };
  } catch (err) {
    console.error('[BAN reverse] erreur', err);
    return null;
  }
}

// ============= Validation périmètre CCOLC =============

/**
 * Vérifie qu'un signalement (par code INSEE BAN ou par point dans GeoJSON)
 * est bien dans le périmètre CCOLC. Stratégie en cascade :
 *   1. Si codeInsee fourni → check direct dans la liste (rapide)
 *   2. Sinon, point-in-polygon contre le GeoJSON (plus lent mais robuste)
 */
export function isInCcolc({ codeInsee, lat, lon }, ccolcGeojson) {
  if (codeInsee && COMMUNES_CCOLC_INSEE.has(codeInsee)) return true;
  if (codeInsee && !COMMUNES_CCOLC_INSEE.has(codeInsee)) {
    // Si on a un code INSEE explicite et qu'il n'est pas CCOLC, c'est non.
    return false;
  }
  // Pas de code INSEE (clic sur carte) → point-in-polygon
  if (!ccolcGeojson) return false;
  return pointInGeoJson([lon, lat], ccolcGeojson);
}

/** Algorithme ray-casting point-in-polygon (multi-polygons supportés). */
export function pointInGeoJson(point, geojson) {
  const features = geojson.features || [geojson];
  for (const feat of features) {
    const g = feat.geometry || feat;
    if (g.type === 'Polygon') {
      if (pointInPolygon(point, g.coordinates)) return true;
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        if (pointInPolygon(point, poly)) return true;
      }
    }
  }
  return false;
}

function pointInPolygon(point, rings) {
  // rings[0] = outer, rings[1..] = holes
  if (!pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false; // dans un trou
  }
  return true;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ============= Distance & intersections =============

/** Distance haversine en mètres. */
export function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Calcule les zones de confiance par intersection de cercles.
 * Stratégie : pour chaque paire/triplet de signalements dont les cercles
 * se chevauchent, on identifie le barycentre comme "zone d'intersection"
 * et on compte combien de cercles le contiennent.
 *
 * Résultat : tableau de zones avec niveau de confiance.
 */
export function calculerZonesConfiance(signalements, rayonMetres = CONFIG.RAYON_VOL_METRES) {
  if (signalements.length < 2) return [];

  // Pour chaque signalement, on compte combien d'autres signalements
  // se trouvent dans un rayon de 2*R (= chevauchement de cercles possible).
  const zones = [];
  const dejaVus = new Set();

  for (let i = 0; i < signalements.length; i++) {
    if (dejaVus.has(i)) continue;
    const groupe = [i];
    for (let j = i + 1; j < signalements.length; j++) {
      const d = haversine(
        [signalements[i].lat, signalements[i].lon],
        [signalements[j].lat, signalements[j].lon]
      );
      if (d <= 2 * rayonMetres) groupe.push(j);
    }

    if (groupe.length >= 2) {
      // Barycentre pondéré (poids = fraîcheur)
      const now = Date.now();
      let sumLat = 0, sumLon = 0, sumW = 0;
      for (const idx of groupe) {
        const s = signalements[idx];
        const ageDays = (now - new Date(s.dateCreation).getTime()) / 86400_000;
        const w = Math.max(0.1, 1 - ageDays / CONFIG.DUREE_VALIDITE_JOURS);
        sumLat += s.lat * w;
        sumLon += s.lon * w;
        sumW += w;
        dejaVus.add(idx);
      }
      zones.push({
        lat: sumLat / sumW,
        lon: sumLon / sumW,
        nbSignalements: groupe.length,
        signalementIds: groupe.map(idx => signalements[idx].id),
        niveau: niveauConfiance(groupe.length),
      });
    }
  }

  return zones.sort((a, b) => b.nbSignalements - a.nbSignalements);
}

function niveauConfiance(n) {
  if (n >= CONFIG.SEUIL_CONFIANCE_TRES_ELEVE) return 'tres_elevee';
  if (n >= CONFIG.SEUIL_CONFIANCE_ELEVE) return 'elevee';
  return 'moyenne';
}

export const COULEURS_CONFIANCE = {
  tres_elevee: { color: '#7f1d1d', label: 'Très élevée' },
  elevee:      { color: '#c2410c', label: 'Élevée' },
  moyenne:     { color: '#ca8a04', label: 'Moyenne' },
};

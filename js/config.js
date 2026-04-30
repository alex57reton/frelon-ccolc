/**
 * Configuration globale de l'application Frelon CCOLC
 *
 * IMPORTANT : modifier WORKER_URL après déploiement du Cloudflare Worker.
 * Tant que le Worker n'est pas déployé, l'app fonctionne en mode "lecture seule
 * locale" : les signalements sont stockés dans le localStorage du navigateur
 * et visibles uniquement sur la machine de l'agent.
 */

export const CONFIG = {
  // URL du Cloudflare Worker (à mettre à jour après déploiement)
  // Tant que c'est null, mode local-storage seulement
  WORKER_URL: null, // ex: 'https://frelon-ccolc.alexandre-halter.workers.dev'

  // Paramètres métier
  RAYON_VOL_METRES: 700,
  DUREE_VALIDITE_JOURS: 30,
  SEUIL_CONFIANCE_ELEVE: 3,
  SEUIL_CONFIANCE_TRES_ELEVE: 5,

  // Centre pondéré (population) du territoire CCOLC
  CARTE_CENTRE: [49.2131, 5.9518],
  CARTE_ZOOM: 11,

  // Limites strictes (bounding box ~ CCOLC élargi pour sécuriser)
  // Empêche aussi les clics aberrants en dehors de la zone
  CARTE_BBOX: [[49.05, 5.75], [49.35, 6.20]],

  // API geo.api.gouv.fr — fallback si GeoJSON statique absent
  GEOJSON_PATH: 'assets/ccolc-perimeter.geojson',

  // API Base Adresse Nationale (BAN)
  BAN_URL: 'https://api-adresse.data.gouv.fr/search/',
  BAN_LIMIT: 6,
  BAN_DEBOUNCE_MS: 250,

  // Tuiles OSM
  TUILES: {
    osm: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    },
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles © Esri',
      maxZoom: 18,
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '© OpenStreetMap, © CartoDB',
      maxZoom: 20,
    },
  },
};

// Codes INSEE des 41 communes CCOLC (54 = Meurthe-et-Moselle)
// Source : liste officielle CCOLC fournie par Alexandre HALTER, avril 2026
export const COMMUNES_CCOLC_INSEE = new Set([
  '54028', // Auboué (siège)
  '54002', // Abbéville-lès-Conflans
  '54004', // Affléville
  '54009', // Allamont
  '54018', // Anoux
  '54036', // Avril
  '54048', // Les Baroches
  '54051', // Batilly
  '54058', // Béchamps
  '54066', // Bettainvillers
  '54082', // Boncourt
  '54093', // Brainville
  '54103', // Bruville
  '54136', // Conflans-en-Jarnisy
  '54171', // Doncourt-lès-Conflans
  '54198', // Fléville-Lixières
  '54213', // Friauville
  '54227', // Giraumont
  '54231', // Gondrecourt-Aix
  '54253', // Hatrize
  '54263', // Homécourt
  '54273', // Jarny
  '54277', // Jeandelize
  '54280', // Jœuf
  '54283', // Jouaville
  '54286', // Labry
  '54302', // Lantéfontaine
  '54326', // Lubey
  '54371', // Moineville
  '54389', // Mouaville
  '54391', // Moutiers
  '54402', // Norroy-le-Sec
  '54408', // Olley
  '54413', // Ozerailles
  '54440', // Puxe
  '54469', // Saint-Ail
  '54478', // Saint-Marcel
  '54524', // Thumeréville
  '54099', // Val de Briey
  '54542', // Valleroy
  '54581', // Ville-sur-Yron
]);

# 🎯 Frelon CCOLC

Système de triangulation des nids de frelons asiatiques (*Vespa velutina*) sur le territoire de la **Communauté de Communes Orne Lorraine Confluences** (41 communes, Meurthe-et-Moselle).

> Outil interne réservé aux agents CCOLC.

## Principe

1. Un agent identifie un frelon asiatique sur le terrain
2. Il signale l'observation via la carte (clic ou recherche d'adresse BAN)
3. L'application trace un cercle de **700 m** (rayon moyen de vol d'une ouvrière) autour du point
4. Lorsque **3 cercles ou plus se chevauchent**, une zone de présence probable du nid est déterminée par triangulation pondérée par la fraîcheur des signalements
5. Les signalements expirent automatiquement après **30 jours** (mais sont conservés sans limite dans un registre permanent à des fins d'analyse historique)

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  GitHub Pages (statique)        │  Cloudflare Worker (backend)   │
│  ─────────────────────────────  │  ─────────────────────────────  │
│  • index.html, disclaimer.html  │  • Auth (mot de passe partagé)  │
│  • Leaflet (carte OSM)          │  • POST /signalements (KV)      │
│  • API BAN (autocomplétion)     │  • GET  /signalements           │
│  • Triangulation côté client    │  • Cron purge nocturne (>30j)   │
│  • Périmètre CCOLC (GeoJSON)    │  • Registre permanent (KV)      │
└──────────────────────────────────────────────────────────────────┘
```

**Aucune donnée personnelle** n'est collectée hors de l'environnement Cloudflare/GitHub. Les photos sont stockées en base64 dans le KV Cloudflare (taille max 5 Mo par photo).

## Arborescence

```
frelon-ccolc/
├── index.html                  # App principale
├── disclaimer.html             # Avertissement initial obligatoire
├── css/
│   ├── app.css                 # Styles principaux
│   └── markers.css             # Marqueurs Leaflet personnalisés
├── js/
│   ├── app.js                  # Orchestrateur principal
│   ├── config.js               # Constantes & codes INSEE des 41 communes
│   ├── auth.js                 # Authentification agent
│   ├── api.js                  # Couche d'accès au Worker (avec fallback localStorage)
│   ├── geo.js                  # Géocodage BAN, point-in-polygon, triangulation
│   └── map.js                  # Wrapper Leaflet (couches, marqueurs, zones)
├── assets/
│   ├── logo.png
│   ├── frelon_asiatique.jpg
│   ├── autres_insectes.jpg
│   └── ccolc-perimeter.geojson # Généré par scripts/generate_ccolc_geojson.py
├── worker/
│   ├── index.js                # Cloudflare Worker
│   └── wrangler.toml           # Configuration de déploiement
├── scripts/
│   └── generate_ccolc_geojson.py  # Génération du GeoJSON CCOLC depuis l'API gouv
└── .github/workflows/
    ├── deploy.yml              # Déploiement GitHub Pages
    └── purge.yml               # Filet de sécurité purge >30j
```

## Installation et déploiement

### Étape 1 — Générer le GeoJSON des 41 communes CCOLC

Localement (sur ton poste, pas sur GitHub) :

```bash
pip install requests
python scripts/generate_ccolc_geojson.py
```

Le fichier `assets/ccolc-perimeter.geojson` est créé. **Commit puis push.**

> Note : si ce fichier est absent, l'app le récupérera en runtime depuis l'API
> `geo.api.gouv.fr` au premier chargement (mode fallback, plus lent).

### Étape 2 — Déployer le Cloudflare Worker

```bash
# 1. Installation de wrangler
npm install -g wrangler

# 2. Connexion à ton compte Cloudflare
wrangler login

# 3. Création des deux KV namespaces
cd worker
wrangler kv:namespace create "SIGNALEMENTS"
wrangler kv:namespace create "REGISTRE_PERMANENT"

# Récupère les IDs retournés et remplace dans wrangler.toml
# (lignes id = "REMPLACER_PAR_ID_KV_...")

# 4. Création des secrets
wrangler secret put AGENT_PASSWORD     # Mot de passe partagé des agents CCOLC
wrangler secret put JWT_SECRET         # Chaîne aléatoire 32+ caractères

# 5. Déploiement
wrangler deploy
```

À la fin du déploiement, tu obtiens une URL du type :
`https://frelon-ccolc.<ton-compte>.workers.dev`

### Étape 3 — Configurer l'app pour pointer vers le Worker

Édite `js/config.js` :

```js
WORKER_URL: 'https://frelon-ccolc.<ton-compte>.workers.dev',
```

### Étape 4 — Activer GitHub Pages

1. Sur GitHub : **Settings → Pages**
2. **Source** : GitHub Actions
3. Push sur `main` → l'action `deploy.yml` déploie automatiquement

L'app est accessible à `https://<ton-user>.github.io/<repo-name>/`

### Étape 5 — (Optionnel) Configurer les secrets GitHub pour la purge de secours

**Settings → Secrets and variables → Actions** :
- `WORKER_URL` : URL du Worker
- `PURGE_TOKEN` : un token Bearer qu'il faut faire matcher avec une vérification dans `worker/index.js` si tu veux activer cette deuxième couche de purge (le cron Cloudflare suffit en pratique).

## Mode dev local (sans Cloudflare)

Tant que `WORKER_URL` vaut `null` dans `config.js`, l'app fonctionne en mode **localStorage seulement** : les signalements ne sont visibles que sur le navigateur de l'agent. Pratique pour développer/tester, mais inutilisable en production multi-utilisateurs.

Pour tester localement :

```bash
# Serveur statique simple
python -m http.server 8000
# Puis ouvrir http://localhost:8000/disclaimer.html
```

## Sécurité

| Surface           | Mesure                                                    |
|-------------------|-----------------------------------------------------------|
| Auth              | Mot de passe partagé CCOLC + JWT signé HS256 (8h)         |
| Périmètre         | Refus côté client + validation serveur du code INSEE      |
| Photos            | Stockage base64 dans KV (chiffré au repos par Cloudflare) |
| CORS              | À restreindre au domaine GitHub Pages en prod             |
| Purge auto        | Cron Cloudflare quotidien + GitHub Action de secours      |
| Audit trail       | Registre permanent KV non purgé (champ agentSignalant)    |

## Modèle de données

```json
{
  "id": "uuid",
  "lat": 49.156, "lon": 5.879,
  "adresse": "...", "commune": "Jarny", "codeInsee": "54273",
  "typeObservation": "vol|butinage|nid_visible|activite_intense",
  "nombreIndividus": "1-5|6-10|10+|non_compte",
  "commentaire": "texte libre (max 1000)",
  "photoEspece": "data:image/jpeg;base64,...",
  "photoUrl": null,
  "statut": "en_attente|valide|rejete|nid_confirme",
  "agentSignalant": "Prénom Nom",
  "dateCreation": "2026-04-29T14:32:18Z",
  "dateValidation": null,
  "agentValidateur": null
}
```

## Workflow de validation

1. **Création** par un agent → `statut: en_attente` (marqueur gris pointillé sur la carte, pas de cercle de vol)
2. **Validation** par un agent valideur (basée sur la photo `photoEspece`) → `statut: valide` (marqueur plein + cercle 700m)
3. **Confirmation nid** après inspection terrain → `statut: nid_confirme` (marqueur noir)
4. **Rejet** si l'espèce n'est pas *Vespa velutina* → `statut: rejete` (n'apparaît plus sur la carte)

> ⚠ L'interface de validation (panneau "À valider") n'est **pas encore implémentée** dans cette V1 — voir feuille de route ci-dessous.

## Feuille de route

- [ ] Panneau admin de validation des photos (workflow agent valideur)
- [ ] Export CSV / GeoJSON du registre permanent pour analyses historiques
- [ ] Heat-map saisonnière sur 2 ou 3 années cumulées
- [ ] Notification push (Discord webhook ?) à chaque nouveau triangle de confiance ≥ élevée
- [ ] Module de recherche d'agents apicoles / désinsectiseurs agréés à proximité
- [ ] Restriction CORS au seul domaine GitHub Pages CCOLC
- [ ] Réintégration de la couche IA prédictive (`PredicteurNidsFrelons` de l'app.py original) en JS pur

## Crédits

- Cartographie : [OpenStreetMap](https://www.openstreetmap.org/copyright), [CartoDB](https://carto.com/), [Esri](https://www.esri.com/)
- Géocodage : [Base Adresse Nationale](https://adresse.data.gouv.fr/) (Etalab)
- Périmètres : [geo.api.gouv.fr](https://geo.api.gouv.fr/) (IGN/Etalab)
- Conception : Alexandre HALTER, Directeur Urbanisme, Habitat et Gens du Voyage CCOLC

## Licence

Code en usage interne CCOLC. Pour toute réutilisation par une autre collectivité, contacter Alexandre HALTER.

"""
Génère le fichier GeoJSON unifié des 41 communes de la
Communauté de Communes Orne Lorraine Confluences (CCOLC).

Source : API officielle geo.api.gouv.fr (Étalab / IGN)
Usage  : python scripts/generate_ccolc_geojson.py

Le fichier produit (assets/ccolc-perimeter.geojson) est utilisé en runtime
par l'application pour valider qu'un signalement est dans le périmètre.

Régénérer ce fichier uniquement si le périmètre CCOLC change officiellement.
"""

import json
import requests
import sys
from pathlib import Path

# Codes INSEE officiels des 41 communes CCOLC
COMMUNES_CCOLC = [
    ("54028", "Auboué"),
    ("54002", "Abbéville-lès-Conflans"),
    ("54004", "Affléville"),
    ("54009", "Allamont"),
    ("54018", "Anoux"),
    ("54036", "Avril"),
    ("54048", "Les Baroches"),
    ("54051", "Batilly"),
    ("54058", "Béchamps"),
    ("54066", "Bettainvillers"),
    ("54082", "Boncourt"),
    ("54093", "Brainville"),
    ("54103", "Bruville"),
    ("54136", "Conflans-en-Jarnisy"),
    ("54171", "Doncourt-lès-Conflans"),
    ("54198", "Fléville-Lixières"),
    ("54213", "Friauville"),
    ("54227", "Giraumont"),
    ("54231", "Gondrecourt-Aix"),
    ("54253", "Hatrize"),
    ("54263", "Homécourt"),
    ("54273", "Jarny"),
    ("54277", "Jeandelize"),
    ("54280", "Jœuf"),
    ("54283", "Jouaville"),
    ("54286", "Labry"),
    ("54302", "Lantéfontaine"),
    ("54326", "Lubey"),
    ("54371", "Moineville"),
    ("54389", "Mouaville"),
    ("54391", "Moutiers"),
    ("54402", "Norroy-le-Sec"),
    ("54408", "Olley"),
    ("54413", "Ozerailles"),
    ("54440", "Puxe"),
    ("54469", "Saint-Ail"),
    ("54478", "Saint-Marcel"),
    ("54524", "Thumeréville"),
    ("54099", "Val de Briey"),
    ("54542", "Valleroy"),
    ("54581", "Ville-sur-Yron"),
]


def fetch_commune(code_insee: str) -> dict | None:
    """Récupère la commune via son code INSEE (méthode la plus fiable)."""
    url = f"https://geo.api.gouv.fr/communes/{code_insee}"
    params = {
        "fields": "nom,code,codesPostaux,population,centre,contour,surface",
        "format": "geojson",
        "geometry": "contour",
    }
    r = requests.get(url, params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def main():
    out_features = []
    erreurs = []

    print(f"Récupération de {len(COMMUNES_CCOLC)} communes CCOLC via codes INSEE...\n")

    for i, (code, nom) in enumerate(COMMUNES_CCOLC, 1):
        try:
            feat = fetch_commune(code)
            if feat is None:
                erreurs.append(f"{nom} ({code})")
                print(f"  [{i:02d}/41] ❌ {nom} ({code}) : non trouvée")
                continue
            out_features.append(feat)
            api_nom = feat["properties"].get("nom", "?")
            pop = feat["properties"].get("population", "?")
            print(f"  [{i:02d}/41] ✓  {api_nom} ({code}) — pop. {pop}")
        except Exception as e:
            erreurs.append(f"{nom} ({code}) : {e}")
            print(f"  [{i:02d}/41] ⚠  {nom} ({code}) : {e}")

    if erreurs:
        print(f"\n⚠ {len(erreurs)} commune(s) en erreur :")
        for err in erreurs:
            print(f"    - {err}")
        sys.exit(1)

    out = {
        "type": "FeatureCollection",
        "name": "CCOLC - Communauté de Communes Orne Lorraine Confluences",
        "metadata": {
            "communes_count": len(out_features),
            "departement": "54",
            "source": "geo.api.gouv.fr",
        },
        "features": out_features,
    }

    out_path = Path(__file__).parent.parent / "assets" / "ccolc-perimeter.geojson"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")

    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ Écrit : {out_path}")
    print(f"   Taille : {size_kb:.1f} KB | Communes : {len(out_features)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Pont Node -> Leboncoin via la lib `lbc` (pip install lbc, Python 3.10+).

Lit un JSON sur stdin, écrit sur stdout une structure RePlace, ou {"error": "..."}.

Actions :
  {"action": "search", "query", "category", "maxPrice", "minPrice", "allPages",
   "sort", "ownerType", "shippable", "searchInTitleOnly", "limit", "fetchSellers"}
      -> liste d'annonces normalisées (toutes les pages si allPages=true)
  {"action": "detail", "id": <id brut Leboncoin>}
      -> UNE annonce complète (body complet, attributs, vendeur)

Variables d'environnement optionnelles :
  LBC_CITY, LBC_LAT, LBC_LNG, LBC_RADIUS (m, défaut 30000)   -> recherche locale
  LBC_MAX_PAGES (défaut 50)   -> plafond de pages en mode allPages
  LBC_FETCH_SELLERS (défaut 0) -> précharger les vendeurs sur chaque annonce
  LBC_PROXY_HOST, LBC_PROXY_PORT, LBC_PROXY_USER, LBC_PROXY_PASS, LBC_PROXY_SCHEME
"""
import json
import os
import random
import sys
import threading
import time

import lbc

FRONT_TO_LBC = {
    "bons-plans": "TOUTES_CATEGORIES",
    "electronique": "ELECTRONIQUE",
    "sport": "LOISIRS_SPORT_ET_PLEIN_AIR",
    "puericulture": "FAMILLE",
    "maison": "MAISON_ET_JARDIN",
    "epicerie": "LOISIRS_VINS_ET_GASTRONOMIE",
    "jeux": "ELECTRONIQUE_JEUX_VIDEO",
    "beaute": "TOUTES_CATEGORIES",
    "auto-moto": "VEHICULES",
    "mode": "MODE",
    "animalerie": "ANIMAUX",
}
# Estimation forfaitaire par catégorie : (kg CO2, litres d'eau) économisés
ECO = {
    "electronique": (60, 10000),
    "jeux": (15, 3000),
    "mode": (10, 5000),
    "maison": (25, 4000),
    "sport": (30, 4000),
    "puericulture": (20, 3500),
    "epicerie": (5, 1000),
    "beaute": (10, 2500),
    "auto-moto": (500, 20000),
    "animalerie": (5, 1500),
    "bons-plans": (20, 4000),
}

SORT_TO_LBC = {
    "relevance": lbc.Sort.RELEVANCE,
    "newest": lbc.Sort.NEWEST,
    "oldest": lbc.Sort.OLDEST,
    "price-asc": lbc.Sort.EXPENSIVE,
    "price-desc": lbc.Sort.CHEAPEST,
}


def _groups():
    g = {}
    for c in lbc.Category:
        n = c.name
        if n in ("ELECTRONIQUE_JEUX_VIDEO", "ELECTRONIQUE_CONSOLES", "FAMILLE_JEUX_ET_JOUETS", "LOISIRS_JEUX_ET_JOUETS"):
            g[str(c.value)] = "jeux"
        elif n.startswith("ELECTRONIQUE") or n in ("LOISIRS_DVD_FILMS", "LOISIRS_CD_MUSIQUE", "LOISIRS_INSTRUMENTS_DE_MUSIQUE"):
            g[str(c.value)] = "electronique"
        elif n.startswith("MODE"):
            g[str(c.value)] = "mode"
        elif n.startswith(("MAISON_ET_JARDIN", "FAMILLE_MOBILIER")):
            g[str(c.value)] = "maison"
        elif n.startswith(("LOISIRS_SPORT", "LOISIRS_VELOS", "VEHICULES_VELOS", "VEHICULES_EQUIPEMENT")):
            g[str(c.value)] = "sport"
        elif n.startswith("FAMILLE") and n not in ("FAMILLE_JEUX_ET_JOUETS",):
            g[str(c.value)] = "puericulture"
        elif n.startswith("ANIMAUX"):
            g[str(c.value)] = "animalerie"
        elif n.startswith("VEHICULES"):
            g[str(c.value)] = "auto-moto"
        elif n in ("LOISIRS_VINS_ET_GASTRONOMIE",):
            g[str(c.value)] = "epicerie"
    return g


def _condition(ad):
    a = ad.attributes.get("condition")
    label = f"{a.value_label or ''} {a.value or ''}".lower() if a else ""
    if "neuf" in label:
        return "neuf"
    if "très bon" in label or "tres bon" in label or "tresbon" in label:
        return "excellent"
    if "satisf" in label:
        return "satisfaisant"
    return "bon"


def _place(ad):
    loc = ad.location
    if not loc:
        return "France"
    city = loc.city or loc.city_label or "France"
    return f"{city} ({loc.zipcode})" if loc.zipcode else city


def _attributes_dict(ad):
    out = {}
    for key, attr in ad.attributes.items():
        val = attr.value_label or attr.value
        if val:
            out[key] = val
    return out


def _seller(ad, cache):
    uid = getattr(ad, "_user_id", None)
    if not uid or uid in cache:
        return None
    try:
        _throttle()
        user = ad.user
        cache[uid] = user
        return user
    except Exception:  # noqa: BLE001
        cache[uid] = None
        return None


def normalize(ad, groups, requested, seller=None, full=False):
    cat = groups.get(str(ad.category_id)) or (requested if requested in ECO else "maison")
    co2, water = ECO[cat]
    ship = ad.attributes.get("shippable")
    delivery = bool(ship and str(ship.value).lower() == "true")
    price = round(float(ad.price or 0), 2)

    rating = 0
    reviews = 0
    seller_name = "Vendeur Leboncoin"
    account_type = "private"
    badges = []
    if seller is not None:
        if seller.feedback:
            rating = round(seller.feedback.score or 0, 1)
            reviews = int(seller.feedback.received_count or 0)
        seller_name = seller.name or seller_name
        account_type = seller.account_type or account_type
        badges = [b.name for b in (seller.badges or [])]
    else:
        # Sans requête vendeur : type détecté via les attributs de l'annonce
        owner_attr = ad.attributes.get("owner_type")
        if owner_attr:
            ov = f"{owner_attr.value_label or owner_attr.value or ''}".lower()
            if "pro" in ov:
                account_type = "pro"
            elif "particulier" in ov:
                account_type = "private"

    # Tempérament de négo estimé (sans requête) : Pro = souple, Particulier = ferme
    neg_temp = "cool" if account_type == "pro" else "firm"
    if rating and rating >= 4.5:
        neg_temp = "cool"
    elif rating and rating <= 3.0:
        neg_temp = "hard"

    # Perception du risque : faible si bonne note, élevé si prix anormalement bas
    scam = "moyen"
    if rating >= 4.5 and reviews >= 5:
        scam = "faible"
    elif price and price <= 15 and "iphone" in str(ad.subject or "").lower():
        scam = "eleve"
    elif rating and rating < 3.0:
        scam = "eleve"

    return {
        "id": f"leboncoin-{ad.id}",
        "title": ad.subject or "Sans titre",
        "category": cat,
        "categoryName": ad.category_name or "",
        "brand": ad.brand or "",
        "price": price,
        "images": (ad.images or []) or ["https://via.placeholder.com/500x400?text=Leboncoin"],
        "image": (ad.images or [None])[0] or "https://via.placeholder.com/500x400?text=Leboncoin",
        "condition": _condition(ad),
        "attributes": _attributes_dict(ad),
        "delivery": delivery,
        "shippingPrice": 0,
        "local": not delivery,
        "location": _place(ad),
        "locationDetails": {
            "city": (ad.location.city if ad.location else None),
            "department": (ad.location.department_name if ad.location else None),
            "region": (ad.location.region_name if ad.location else None),
            "zipcode": (ad.location.zipcode if ad.location else None),
            "lat": (ad.location.lat if ad.location else None),
            "lng": (ad.location.lng if ad.location else None),
        },
        "description": (ad.body or "")[:2000 if full else 600],
        "url": ad.url,
        "publishedAt": ad.first_publication_date,
        "expiresAt": ad.expiration_date,
        "sellerName": seller_name,
        "sellerRating": rating,
        "sellerReviews": reviews,
        "sellerType": account_type,
        "sellerBadges": badges,
        "ecoScore": {"waterSaved": water, "co2Saved": co2},
        "scamRisk": scam,
        "ecoPackaging": False,
        "priceHistory": [price],
        "negTemp": neg_temp,
        "pitch": (int(getattr(ad, "stories", 0) or 0) if hasattr(ad, "stories") else 0),
        "live": True,
    }


def _client():
    proxy = None
    if os.environ.get("LBC_PROXY_HOST"):
        p = {"host": os.environ["LBC_PROXY_HOST"], "port": int(os.environ["LBC_PROXY_PORT"]),
             "scheme": os.environ.get("LBC_PROXY_SCHEME", "http")}
        if os.environ.get("LBC_PROXY_USER"):
            p.update(username=os.environ["LBC_PROXY_USER"], password=os.environ.get("LBC_PROXY_PASS", ""))
        proxy = lbc.Proxy(**p)
    return lbc.Client(proxy=proxy)


# --- Anti-Datadome : débit contrôlé + retries avec backoff ---
_rate_lock = threading.Lock()
_last_request = 0.0


def _throttle():
    """Espace les appels au moins toutes les N secondes."""
    global _last_request  # noqa: PLW0603
    min_gap = float(os.environ.get("LBC_MIN_GAP_SECONDS", "4"))
    with _rate_lock:
        now = time.monotonic()
        wait = _last_request + min_gap - now
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic() + random.uniform(0, 0.5)


def _request(fn, *args, **kwargs):
    """Exécute une requête lbc avec throttling global et retries sur Datadome."""
    max_tries = int(os.environ.get("LBC_MAX_RETRIES", "3"))
    backoff = float(os.environ.get("LBC_BACKOFF", "5"))
    for attempt in range(max_tries):
        _throttle()
        try:
            return fn(*args, **kwargs)
        except lbc.exceptions.DatadomeError:
            if attempt == max_tries - 1:
                raise
            sleep = backoff * (2 ** attempt) + random.uniform(0, 2)
            err = sys.stderr
            err.write(f"[lbc_bridge] Datadome bloqué, retry dans {sleep:.0f}s (essai {attempt + 1}/{max_tries})\n")
            err.flush()
            time.sleep(sleep)
    raise lbc.exceptions.DatadomeError("Access blocked by Datadome")


def search(payload):
    requested = payload.get("category") or "all"
    client = _client()
    groups = _groups()

    kwargs = dict(
        text=(payload.get("query") or "").strip() or None,
        category=getattr(lbc.Category, FRONT_TO_LBC.get(requested, "TOUTES_CATEGORIES")),
        sort=SORT_TO_LBC.get(payload.get("sort") or "newest", lbc.Sort.NEWEST),
        ad_type=lbc.AdType.OFFER,
        page=1,
        limit=int(payload.get("limit") or 35),
        limit_alu=0,
    )
    if payload.get("searchInTitleOnly"):
        kwargs["search_in_title_only"] = True
    if payload.get("ownerType"):
        ot = payload["ownerType"]
        if ot in ("pro", "private"):
            kwargs["owner_type"] = getattr(lbc.OwnerType, ot.upper())
    if payload.get("shippable") is not None:
        kwargs["shippable"] = bool(payload["shippable"])
    if payload.get("minPrice") or payload.get("maxPrice"):
        # min=0 ne filtre pas : les annonces "échange" sans prix passent. On force min>=1.
        lo = max(1, int(float(payload.get("minPrice") or 1)))
        hi = int(float(payload.get("maxPrice") or 0)) or None
        kwargs["price"] = [lo, hi]

    env = os.environ
    if env.get("LBC_CITY") and env.get("LBC_LAT") and env.get("LBC_LNG"):
        kwargs["locations"] = [lbc.City(lat=float(env["LBC_LAT"]), lng=float(env["LBC_LNG"]),
                                        radius=int(env.get("LBC_RADIUS", "30000")), city=env["LBC_CITY"])]

    fetch_sellers = bool(payload.get("fetchSellers")) or env.get("LBC_FETCH_SELLERS") == "1"

    # Limiter strictement le nombre de vendeurs préchargés par recherche
    # (chaque vendeur = 1 requête API => risque Datadome). Défaut : jamais en recherche.
    seller_limit = 0
    if fetch_sellers:
        seller_limit = int(env.get("LBC_SELLER_LIMIT", "5"))

    max_pages = int(env.get("LBC_MAX_PAGES", "50"))

    first = _request(client.search, **kwargs)
    all_ads = list(first.ads)
    total = getattr(first, "total", None) or len(all_ads)
    max_pages_total = getattr(first, "max_pages", 1) or 1
    page_errors = []

    if payload.get("allPages"):
        pages = min(max_pages_total, max_pages)
        for page in range(2, pages + 1):
            try:
                kwargs["page"] = page
                res = _request(client.search, **kwargs)
                all_ads.extend(res.ads)
            except lbc.exceptions.DatadomeError:
                page_errors.append({"page": page, "error": "Datadome: blocage, pagination interrompue"})
                break
            except Exception as e:  # noqa: BLE001
                page_errors.append({"page": page, "error": f"{type(e).__name__}: {e}"})
                break

    seller_cache = {}
    out = []
    sellers_done = 0
    for ad in all_ads:
        seller = None
        if sellers_done < seller_limit:
            seller = _seller(ad, seller_cache)
            if seller is not None:
                sellers_done += 1
        out.append(normalize(ad, groups, requested, seller=seller))

    # dédoublonnage par id (lbc peut répéter des annonces entre pages)
    seen, unique = set(), []
    for ad in out:
        if ad["id"] in seen:
            continue
        seen.add(ad["id"])
        unique.append(ad)

    result = {
        "results": unique,
        "total": total,
        "totalFetched": len(unique),
        "maxPages": max_pages_total,
        "pagination": "complete" if payload.get("allPages") else "page-1",
    }
    if page_errors:
        result["pageErrors"] = page_errors
    return result


def detail(payload):
    ad_id = str(payload.get("id") or "").replace("leboncoin-", "")
    if not ad_id:
        raise ValueError("id manquant")
    client = _client()
    ad = _request(client.get_ad, ad_id)
    groups = _groups()
    requested = "all"
    seller = None
    try:
        _throttle()
        seller = ad.user
    except Exception:  # noqa: BLE001
        seller = None
    return normalize(ad, groups, requested, seller=seller, full=True)


def run(payload):
    action = payload.get("action") or "search"
    if action == "detail":
        return detail(payload)
    return search(payload)


def main():
    try:
        out = run(json.loads(sys.stdin.read() or "{}"))
    except Exception as e:  # noqa: BLE001
        out = {"error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
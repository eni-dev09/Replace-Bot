# Replace-Bot — bonnes affaires Leboncoin + Vinted sur Discord

## Installation
1. https://discord.com/developers/applications → New Application → onglet **Bot** → *Reset Token* (copie-le).
2. Copie l'**Application ID** (General Information).
3. Invitation : OAuth2 → URL Generator → scopes `bot` + `applications.commands`, permissions
   *View Channels, Send Messages, Embed Links, Read Message History* → ouvre l'URL et choisis ton serveur.
4. Copie `.env.example` vers `.env` et renseigne `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` et `DISCORD_GUILD_ID`, puis :
```
npm install
npm start
```
Aucun intent privilégié requis. Leboncoin demande en plus Python 3.10+ et `pip install -r requirements.txt` ;
sans ça il est désactivé automatiquement et le bot tourne avec Vinted seul (cas de Bot-Hosting).

## Déploiement
- **Bot-Hosting / hébergeur Node** : déployer le contenu du dépôt à la racine du serveur, fichier principal `index.js`, puis définir les variables Discord dans le panel ou `.env`. Le panel doit lancer `npm install` puis `node index.js`. Sans Python, Leboncoin se désactive tout seul (Vinted reste actif).
- **VPS / Docker (Leboncoin inclus)** : `cp .env.example .env && docker compose up -d --build`.
- Les recherches sont mises en cache 5 min (`SEARCH_CACHE_TTL_S`, 0 = désactivé).

## Utilisation par mention (le plus simple)
| Tu écris | Le bot répond |
|---|---|
| `@bot rtx 3070ti` | Prix médian du marché (par plateforme) + 5 meilleures offres avec verdict de fiabilité rapide |
| `@bot rtx 3070ti max 300€ -coque` | Pareil, dans ton budget, en excluant le mot « coque » |
| `@bot https://www.leboncoin.fr/ad/...` | Analyse de fiabilité complète de l'annonce (lien Leboncoin ou Vinted) |
| `@bot` + capture d'écran jointe | Idem depuis la capture (nécessite `OPENAI_API_KEY`, ou `ANTHROPIC_API_KEY`) |

## Commandes slash
| Commande | Rôle |
|---|---|
| `/deals produit [prix_max] [plateforme]` | Même chose que la mention |
| `/analyse [lien] [image]` | Fiabilité d'une annonce |
| `/radar add produit prix_max [plateforme] [salon] [role] [exclure] [remise_min]` | Alerte permanente (réservé « Gérer le serveur ») |
| `/radar list` · `remove` · `scan` · `status` | Gestion |

## Comment c'est calculé
- **Marché** : ~40 annonces par plateforme, filtrées par pertinence (le titre doit contenir les mots recherchés,
  « 3070ti » = « 3070 Ti »), accessoires / pièces / « HS » / lots exclus, valeurs aberrantes écartées, puis médiane.
  Le plafond de budget n'est PAS appliqué à la médiane (il la fausserait), seulement aux offres affichées.
- **Fiabilité** (risque 0-100) : écart de prix vs médiane, tentatives de sortir de la plateforme (WhatsApp, mail,
  virement, PayPal amis, lien de paiement…), formulations de pression, note et nombre d'avis du vendeur,
  signaux visibles sur la capture. Verdicts : ✅ fiable · ⚠️ à vérifier · 🟠 risque élevé · 🚫 très suspect.
  C'est une **estimation**, jamais une garantie.
- **Radar** : deal = prix ≤ médiane × (1 − remise_min) ; déduplication persistante ; ping de rôle une fois par scan.

## Ajouter une plateforme
`bot/platforms/<nom>.js` : `{ id, label, emoji, color, available, search(), parseUrl(), getAd() }`
(voir `vinted.js`), puis la déclarer dans `bot/platforms/index.js`.

## Notes
- Leboncoin (Datadome) et Vinted peuvent limiter les requêtes : appels espacés (10 s / 4 s), cache des recherches et 10 s de pause par utilisateur entre deux mentions. Les limites de la plateforme doivent être respectées ; des réponses 403/429 demandent de réessayer plus tard, sans tenter de contourner leur protection.
- La recherche Vinted utilise désormais `https://api.<domaine>/svc-catalogue/items` avec une session anonyme obtenue depuis le site `www`. L'API est non officielle et peut changer sans préavis. Les erreurs 401/403 déclenchent un renouvellement limité de session ; les 404 sont remontées comme erreurs de route.
- Le chargement de l'annonce détaillée utilise encore l'ancienne route `/api/v2/items/:id` ; Vinted peut aussi la modifier séparément. La recherche catalogue a des tests mockés, mais n'a pas été validée sur un vrai compte ou une vraie instance Vinted.
- `npm test` : tests de logique et tests mockés de l'adaptateur Vinted, sans accès réseau réel ni Discord.
- Analyse de capture d'écran : fournisseur d'IA au choix, **OpenAI** (`OPENAI_API_KEY`, modèle `OPENAI_MODEL`, défaut `gpt-6.1-terra`, moins cher `gpt-6-luna`) ou Anthropic. L'API est facturée à part de l'abonnement ChatGPT/Claude (crédits sur platform.openai.com → Billing). Sans crédits, le bot demande d'envoyer le lien à la place.

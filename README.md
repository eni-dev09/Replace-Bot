# Replace-Bot — bonnes affaires Leboncoin + Vinted sur Discord

## Installation
1. https://discord.com/developers/applications → New Application → onglet **Bot** → *Reset Token* (copie-le).
2. Copie l'**Application ID** (General Information).
3. Invitation : OAuth2 → URL Generator → scopes `bot` + `applications.commands`, permissions
   *View Channels, Send Messages, Embed Links, Read Message History* → ouvre l'URL et choisis ton serveur.
4. `cp .env.example .env` (remplis `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`) puis :
```
npm install
npm run bot
```
Aucun intent privilégié requis. Leboncoin demande en plus Python 3.10+ et `pip install -r requirements.txt` ;
sans ça il est désactivé automatiquement et le bot tourne avec Vinted seul (cas de Bot-Hosting).

## Déploiement
- **Bot-Hosting / hébergeur Node** : envoyer le dépôt, fichier principal `index.js`, variables dans `.env`.
  Sans Python, Leboncoin se désactive tout seul (Vinted reste actif).
- **VPS / Docker (Leboncoin inclus)** : `cp .env.example .env && docker compose up -d --build`.
- Les recherches sont mises en cache 5 min (`SEARCH_CACHE_TTL_S`, 0 = désactivé).

## Utilisation par mention (le plus simple)
| Tu écris | Le bot répond |
|---|---|
| `@bot rtx 3070ti` | Prix médian du marché (par plateforme) + 5 meilleures offres avec verdict de fiabilité rapide |
| `@bot rtx 3070ti max 300€ -coque` | Pareil, dans ton budget, en excluant le mot « coque » |
| `@bot https://www.leboncoin.fr/ad/...` | Analyse de fiabilité complète de l'annonce (lien Leboncoin ou Vinted) |
| `@bot` + capture d'écran jointe | Idem depuis la capture (nécessite `ANTHROPIC_API_KEY`) |

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
- Leboncoin (Datadome) et Vinted bloquent les requêtes trop rapides : appels espacés (10 s / 4 s), 10 s de pause
  par utilisateur entre deux mentions. Les IP d'hébergeurs gratuits sont souvent bloquées : proxy ou VPS en cas d'erreur 403/429.
- Vinted : API web non officielle, peut changer sans préavis.
- `npm test` : tests de la logique, sans réseau ni Discord.

# VRCX-0 Web

[English](README.md) | Français | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja-JP.md) | [한국어](README.ko-KR.md)

**Une version Web Docker basée sur [VRCX-0](https://github.com/Map1en/VRCX-0), dont le développement est piloté par ChatGPT.**

Ce fork part de la version originale **v2.32.0** et réutilise autant que possible la logique Rust, les bases de données et l’interface React. Les modifications restent limitées pour faciliter l’intégration des évolutions du projet d’origine. La branche de développement est `feat/web-headless` ; il s’agit d’une première version fonctionnelle.

Le service fonctionne sur un serveur Linux sans bureau ni écran, accessible depuis un navigateur. Il est destiné à un seul utilisateur : un compte VRChat actif, avec les mêmes réglages et données partagés entre plusieurs navigateurs. ChatGPT intervient dans le développement ; aucun compte ChatGPT n’est nécessaire pour le fonctionnement de base. Les fonctions d’IA facultatives nécessitent leur propre fournisseur.

## Démarrage avec Docker Compose

Prérequis : Linux, Docker et le plugin Docker Compose. Dans le dossier du dépôt, exécutez `cp .env.example .env`, puis modifiez `.env` avec votre domaine réel et un mot de passe Web distinct d’au moins 12 caractères :

```dotenv
VRCX_WEB_ORIGIN=https://vrcx.example.com
VRCX_WEB_PASSWORD=replace-with-your-own-strong-password
VRCX_WEB_LAN_MODE=0
VRCX_WEB_LISTEN=127.0.0.1
VRCX_WEB_PORT=8080
TZ=Asia/Shanghai
```

Téléchargez l’image et démarrez le service :

```sh
cp compose.example.yaml compose.yaml
docker compose pull
docker compose up -d
docker compose logs -f web
```

Par défaut, le service écoute sur `127.0.0.1:8080`. `VRCX_WEB_ORIGIN` doit correspondre exactement au protocole, à l’hôte et au port de l’adresse du navigateur, sans sous-chemin. Ajoutez [la configuration Nginx](deploy/nginx.web.conf) au bloc HTTPS `server` de votre domaine. Nginx gère le certificat et la redirection HTTPS ; l’application utilise HTTP. Désactivez la mise en tampon du proxy pour le flux SSE. Si Nginx fonctionne aussi dans un conteneur, utilisez un réseau Docker commun et la cible `web:8080`.

Connectez-vous d’abord au site, puis à VRChat dans l’interface d’origine, avec l’authentification à deux facteurs si nécessaire. Le mot de passe du site est indépendant de celui de VRChat.

## Accès HTTP sur le réseau local

Ce mode ne nécessite ni domaine, ni certificat, ni Nginx. Modifiez `.env` :

```dotenv
VRCX_WEB_LAN_MODE=1
VRCX_WEB_LISTEN=0.0.0.0
VRCX_WEB_PORT=8080
```

Uniquement en mode LAN, laisser `VRCX_WEB_PASSWORD` vide ou non défini permet un accès sans connexion au site. Si un mot de passe est défini, la connexion reste obligatoire et le mot de passe doit comporter au moins 12 caractères. La connexion VRChat reste distincte. Configurez un mot de passe avant de revenir au mode à origine fixe.

Exécutez `docker compose pull && docker compose up -d`, puis ouvrez `http://192.168.1.10:8080` en remplaçant l’adresse IP par celle du serveur. Ce mode ignore `VRCX_WEB_ORIGIN` et vérifie la correspondance entre Origin et Host. Il accepte les IPv4 privées, IPv6 ULA, adresses locales au lien et de bouclage, ainsi que `localhost`. Les noms de domaine ordinaires utilisent le mode à origine fixe. Le navigateur peut limiter le presse-papiers en HTTP. Pour revenir à HTTPS, réglez le mode LAN sur `0` et restaurez l’adresse d’écoute et votre origine HTTPS.

## Fonctions et fonctionnement en arrière-plan

- Réutilisation de l’interface, des statuts des amis, de l’historique social, des favoris, mondes, avatars, groupes, invitations, notifications, notes, étiquettes et statistiques.
- Conservation des Webhooks, de l’intégration du logger distant, de la traduction et des fournisseurs d’IA facultatifs. Les services tiers nécessitent leur propre configuration. Les Webhooks sont envoyés par le serveur.
- La collecte continue après la fermeture du navigateur ou la déconnexion du site. Une déconnexion explicite de VRChat termine la session VRChat.
- Désactivation de la surveillance du jeu local, des journaux du jeu, des captures d’écran et du VR Overlay. Les commandes de bureau, dont la zone de notification, les fenêtres, le démarrage automatique, les notifications de bureau et Discord RPC, sont masquées.
- Aucun nouveau mécanisme de suppression des historiques selon leur âge. Les paramètres existants de maintenance et de conservation des sauvegardes restent applicables.
- Actualisation habituelle des amis/favoris toutes les heures et de l’utilisateur courant toutes les 5 minutes. L’analyse des biographies est désactivée par défaut ; une fois activée, elle traite un candidat toutes les 3 secondes, avec au moins 12 heures entre deux analyses du même utilisateur, sous réserve de la planification et des limites d’origine.

## Données, sauvegardes et mises à jour

Les bases de données, sessions, réglages, caches et sauvegardes sont conservés dans **`./data`**, même après reconstruction du conteneur. L’arrêt de `init-data` après son exécution réussie est normal. Le service utilise l’UID/GID `10001:10001`. Incluez impérativement `./data/.machine-id` dans toute sauvegarde ou migration du dossier complet. Ne partagez pas un même dossier entre plusieurs instances en cours d’exécution.

Les sélecteurs de fichiers sont remplacés par les transferts du navigateur, limités à 256 MiB par requête d’envoi. Les copies des exports manuels se trouvent dans `./data/web-files`, les données de migration VRCX dans `./data/legacy`. L’interface de restauration accepte les fichiers `.vrcx0backup`.

Pour une sauvegarde complète, exécutez `docker compose stop web`, copiez tout `./data`, fichiers cachés compris, puis exécutez `docker compose start web`. Restaurez avec le propriétaire `10001:10001`. Les sauvegardes contiennent les sessions des comptes.

Pour mettre à jour l’image, exécutez `docker compose pull && docker compose up -d`. Arrêtez les services avec `docker compose down`. Les sessions Web durent au maximum 7 jours et nécessitent une nouvelle connexion après redémarrage ; les sessions VRChat persistées restent distinctes. Après modification du mot de passe Web, exécutez `docker compose up -d --force-recreate web`.

## Développement et documentation détaillée

Consultez le [README anglais](README.md) pour l’architecture, la compilation, les migrations et la synchronisation avec le projet d’origine. Les adaptations se trouvent principalement dans `crates/web-server` et `src/platform/web`. Les vérifications automatisées couvrent notamment l’authentification Web et les limites d’accès aux fichiers. La connexion VRChat réelle, la double authentification, les événements de longue durée et la livraison des Webhooks doivent encore être validés avec des comptes et des destinataires réels.

## Crédits et licence

Merci aux auteurs et contributeurs de [Map1en/VRCX-0](https://github.com/Map1en/VRCX-0). Ce dépôt est une version dérivée indépendante pour Docker et le Web. Signalez ici les problèmes propres à cette version. La licence [GNU GPL v3.0](LICENSE) est conservée. Pour les portions provenant de VRCX, consultez [NOTICE](NOTICE) et [LICENSES/MIT.txt](LICENSES/MIT.txt). Ce projet n’est pas approuvé par VRChat Inc. ; les marques appartiennent à leurs propriétaires respectifs.

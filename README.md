# Cantieri - foto e video in Fabric

Demo web mobile-first: dopo il login Microsoft ci sono due azioni principali,
**Visualizza materiale** e **Carica foto o video**. Il backend usa l'identita'
dell'utente per accedere a **Microsoft Fabric OneLake**. Nessun account Storage
Azure separato, chiave di storage o account tecnico con accesso generale ai file.

Il progetto prepara il container; **non crea risorse Azure e non esegue deploy**.

## Funzionalita'

- Login Microsoft Entra ID, limitato al tenant configurato.
- Cartella iniziale `MaterialiCantiere / Files/demo`, nel workspace `Cantieri`.
  Navigazione delle sottocartelle, elenco paginato, anteprima e download.
- Upload multiplo di foto/video, un file alla volta, massimo **250 MB per file**
  (250.000.000 byte), modificabile tramite `MAX_UPLOAD_MB`.
- Upload a blocchi da 4 MiB, progresso, annullamento e retry dei blocchi.
  Il backend non carica il video intero in RAM e non usa il disco locale.
- Nomi univoci: un nuovo upload non sovrascrive i file precedenti.
- Verifica di estensione e firma iniziale del contenuto, non del solo MIME
  dichiarato dal browser. JPG/JPEG, PNG, GIF, WebP, HEIC/HEIF, AVIF, MP4,
  MOV, M4V, WebM e 3GP.
- Video con HTTP Range e anteprime su richiesta, senza scaricare l'intera
  raccolta all'apertura dell'elenco. I codec e le anteprime HEIC/MOV dipendono
  dal browser: resta disponibile il download.
- Cookie HttpOnly, protezione CSRF, OAuth state/nonce e PKCE, CSP,
  rate limiting, controlli sui percorsi e messaggi di errore con riferimento.
- Token e credenziali restano sul server. Non vengono salvati in localStorage,
  nel bundle del browser o nell'immagine Docker.

## 1. Preparare Fabric

Gia' scelti per questa demo:

1. Workspace **Cantieri**, associato a capacita' **Fabric** o **Fabric Trial**.
   La sola licenza Power BI Pro/PPU non fornisce capacita' per un Lakehouse.
2. Lakehouse **MaterialiCantiere**.
3. Cartella **Files/demo** creata nel Lakehouse.

Dal link del Lakehouse si ricavano entrambi gli ID:

```text
https://app.fabric.microsoft.com/groups/<workspace-id>/lakehouses/<lakehouse-id>
```

L'app usa gli ID, non i nomi: rinominare workspace o Lakehouse non interrompe
la connessione. Non crea cartelle, workspace o Lakehouse automaticamente.
Il percorso configurato e' il confine di navigazione dell'app: non e'
possibile risalire a cartelle esterne o ad altri Lakehouse.

### Permessi per cartella

Per la prima prova il creatore del workspace dispone gia' di accesso ai dati.
Per dimostrare l'isolamento fra utenti, **non usare un account Admin, Member o
Contributor**: questi ruoli hanno accesso generale al workspace e non vengono
limitati dai ruoli di sicurezza delle singole cartelle.

Per un utente limitato alla cartella `demo`:

1. Condividi il Lakehouse con il permesso **Read** sull'elemento, oppure assegna
   **Viewer** al workspace se deve vedere tutti gli elementi del workspace.
2. Nel Lakehouse apri **Manage OneLake security**.
3. Crea un ruolo, per esempio `DemoUpload`, con **ReadWrite**.
4. Seleziona **Selected data**, poi soltanto **Files/demo**.
5. Aggiungi l'utente o il gruppo Entra al ruolo e salva.
6. Verifica che altri ruoli, inclusi **DefaultReader** e **ReadAll**, non gli
   concedano accesso piu' ampio di quello desiderato.

Per utenti che devono soltanto visualizzare materiale, usa **Read**: l'upload
restituira' un errore di autorizzazione, non elevera' i loro permessi.
La sicurezza rimane in OneLake; non e' una semplice restrizione nell'interfaccia.

La documentazione OneLake prevede ReadWrite granulare tramite le API. Se questa
opzione non compare nel tenant, verificane disponibilita' e configurazione con
l'amministratore Fabric; **Contributor non e' un equivalente limitato alla cartella**.
Non modificare i permessi di altri utenti o ruoli senza verificarne l'impatto.

L'accesso deve inoltre essere consentito dalle eventuali impostazioni del tenant
per applicazioni esterne a Fabric, dalle regole di rete e dalle Conditional Access
policy. Un consenso Entra non supera questi controlli.

## 2. Registrazione Microsoft Entra

Registrazione **Cantieri Upload Demo**, con account del **solo tenant aziendale**.

### Authentication

Piattaforma **Web**, non SPA. Per lo sviluppo locale registra:

```text
http://localhost:3000/auth/callback
http://localhost:3000/
```

La prima URI e' il callback di login; la seconda e' il ritorno dopo il logout.
Non attivare implicit grant, access token impliciti o public client flows.

Quando sara' disponibile l'URL della Container App, aggiungi anche:

```text
https://<fqdn-container-app>/auth/callback
https://<fqdn-container-app>/
```

### API permissions

**Add a permission -> Azure Storage -> Delegated permissions ->
user_impersonation**. Concedi il consenso amministrativo se richiesto dal tenant.
Lo scope richiesto e' `https://storage.azure.com/user_impersonation`;
OneLake richiede un token per l'audience **Storage**, non un token Graph o Fabric REST.
L'app non usa Microsoft Graph e non richiede permessi Graph aggiuntivi.

### Certificates & secrets

Crea un client secret con scadenza adatta alla demo. Usa **Value**, non **Secret ID**.
Inseriscilo in un secret della Container App, referenziato dalla variabile
`ENTRA_CLIENT_SECRET`. Solo se vuoi provare anche il login in locale, inseriscilo
nel file `.env` locale. Non inserirlo in chat, nel repository, in Dockerfile o nei build args.
Alla scadenza occorre ruotarlo. Per un'applicazione di produzione valutare credenziali
piu' robuste e il relativo ciclo di gestione.

## 3. Avvio locale

Questa sezione e' opzionale per chi pubblica direttamente su Container Apps:
le credenziali possono essere configurate esclusivamente a runtime su Azure.

Prerequisito consigliato: **Node.js 24 LTS**; il progetto ammette anche Node 25/26.

```powershell
npm ci
npm run setup:local
```

Il comando di setup crea `.env` da [`.env.example`](.env.example) solo se manca;
genera `SESSION_SECRET` se vuoto, senza mostrarlo e senza sostituirne uno esistente.
Configura poi `.env`. Gli ID della demo forniti durante la preparazione sono gia'
stati inseriti nel file locale, che non viene versionato.

```powershell
npm run build
npm start
```

Apri `http://localhost:3000`. In alternativa `npm run dev` ricompila l'interfaccia
e avvia il backend TypeScript. Dopo aver cambiato `.env`, riavvia il processo.
Non e' previsto un bypass del login: se mancano variabili, la pagina mostra
**Configurazione da completare**. L'app non simula una connessione riuscita a Fabric.

`localhost` sul telefono indica il telefono stesso, non il PC. Per la prova da
cellulare usa l'URL HTTPS della Container App, con i redirect Entra aggiornati.

### Variabili d'ambiente

| Variabile | Valore / significato |
| --- | --- |
| `NODE_ENV` | `development` in locale; `production` nel container |
| `PORT` | `3000` in locale; `8080` nel container |
| `APP_BASE_URL` | Origine pubblica, senza percorso, es. `https://<fqdn>` |
| `ENTRA_TENANT_ID` | Directory (tenant) ID |
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | **Secret**: valore della credenziale applicativa |
| `SESSION_SECRET` | **Secret**: almeno 32 caratteri casuali, stabile fra riavvii |
| `FABRIC_WORKSPACE_ID` | ID del workspace Cantieri |
| `FABRIC_LAKEHOUSE_ID` | ID del Lakehouse MaterialiCantiere |
| `ONELAKE_ROOT_PATH` | `Files/demo` |
| `ONELAKE_ENDPOINT` | `https://onelake.dfs.fabric.microsoft.com` |
| `FOLDER_LABEL` | Etichetta mostrata nell'app, es. `MaterialiCantiere / demo` |
| `MAX_UPLOAD_MB` | `250`; dimensione decimale massima del singolo file |

Per requisiti di residenza dei dati si puo' configurare l'endpoint OneLake
regionale ufficiale corrispondente alla capacita' Fabric. L'app accetta solo
endpoint HTTPS OneLake, non indirizzi arbitrari.

## 4. Container e pubblicazione tramite GitHub

[Dockerfile](Dockerfile) esegue una build multi-stage, usa Node 24, installa solo
dipendenze runtime nello stage finale e avvia il processo come utente non-root.
[.dockerignore](.dockerignore) include esclusivamente i file necessari:
`.env`, `.git`, test e credenziali non entrano nel contesto di build.

Per una prova locale con Docker Desktop Linux avviato:

```powershell
docker build -t cantieri-upload:local .
docker run --rm -p 3000:8080 --env-file .env -e NODE_ENV=development -e PORT=8080 -e APP_BASE_URL=http://localhost:3000 cantieri-upload:local
```

`NODE_ENV=development` in questo comando serve esclusivamente alla prova HTTP su
localhost. Su Azure deve restare **production**, con URL HTTPS e cookie Secure.

### Container App esistente

Collega la repository GitHub tramite l'esperienza di deployment della tua Container
App e lascia al portale il workflow di **deploy**, con le sue credenziali/federazione:

| Impostazione | Valore per questa demo |
| --- | --- |
| Build context / application source | Radice della repository: `.` |
| Dockerfile path | `Dockerfile` |
| Ingress | External, HTTP; non consentire HTTP non sicuro |
| Target port | **8080** |
| CPU / memoria iniziali | Per esempio 0.5 vCPU / 1 GiB, da adeguare alle prove |
| Revision mode | **Single** |
| Repliche minime / massime | **1 / 1** |
| Authentication integrata ACA | Non necessaria: il login Entra e' gestito dall'app |
| Liveness / startup probe | HTTP `GET /healthz`, porta 8080 |
| Readiness probe | HTTP `GET /readyz`, porta 8080 |

Imposta tutte le variabili della tabella precedente sulla revisione. Per
`ENTRA_CLIENT_SECRET` e `SESSION_SECRET` crea secret della Container App e usa
riferimenti ai secret nelle variabili. Imposta `APP_BASE_URL` sul FQDN **HTTPS**
reale e registra le due URI corrispondenti in Entra.

Una build riuscita **non** trasferisce `.env` su Azure: i parametri vanno impostati
sulla Container App a runtime. I due secret non servono per compilare l'immagine
e non devono essere passati a GitHub come argomenti di build.

Il workflow [ci.yml](.github/workflows/ci.yml) effettua typecheck, test, build e smoke
test del container senza credenziali, oltre ai test browser Chromium, Firefox e
WebKit; **non fa deploy e non crea infrastruttura**.
Puo' convivere con il workflow di deployment generato dalla Container App.

## 5. Prova completa

1. Esegui il login e verifica nome utente e cartella.
2. Carica una foto e un video; controlla nome univoco, dimensione e anteprima.
3. In Fabric verifica che i file siano effettivamente in `Files/demo`.
4. Prova da browser mobile, incluso download e riproduzione video.
5. Con un secondo utente **non amministratore**, verifica una cartella consentita
   e una non consentita. Prova anche un utente con sola lettura.
6. Un utente anonimo non deve poter accedere a nessuna API file, neppure conoscendo
   il percorso. Un utente non autorizzato deve ricevere `403`, non un elenco vuoto
   che finga un risultato valido.

Test automatici locali:

```powershell
npm run check
```

Test con browser reali, su backend locale e storage di test:

```powershell
npx playwright install chromium firefox webkit
npm run test:browser
```

Questi test verificano upload a blocchi, rimozione degli upload non validi e
logout tramite l'interfaccia reale. Non usano credenziali Microsoft e non
contattano Azure o Fabric. Il client imposta `referrerPolicy: "same-origin"`
sulle richieste API: Firefox e WebKit possono altrimenti inviare `Origin: null`
con `mode: "same-origin"` e la policy globale `no-referrer`, causando un 403.
La policy globale, anche sul callback OAuth, resta `no-referrer`; il server
continua a richiedere sia l'origine esatta sia il token CSRF della sessione.

I test usano sostituti in memoria di Entra e OneLake esclusivamente nella cartella
`tests`; verificano i contratti e i controlli del backend, non i permessi reali del
tenant. Il collaudo live descritto sopra richiede configurazione e login effettivi.

## 6. Preparazione per Power BI

Foto e video restano nella sezione **Files**, non nella sezione Tables. Il solo
upload non crea automaticamente un modello semantico o un report.

Ogni file caricato riceve metadati OneLake:

- `uploadid`: identificativo del caricamento.
- `uploaderoid`: Object ID Entra dell'utente.
- `originalnamebase64`: nome originale, UTF-8 codificato Base64.
- `createdatutc`: data UTC di inizio del caricamento.
- `declaredbytes`: dimensione dichiarata, verificata prima della pubblicazione.
- `contenttype`: tipo del file.

Un successivo notebook o pipeline Fabric potra' creare una tabella Delta di
inventario, usando i percorsi, le dimensioni, le date e le proprieta' dei file.
Escludi dall'inventario i file temporanei con nome che inizia per `.upload-`.
I metadati personalizzati si leggono tramite le proprieta' del file; non sono una
tabella SQL gia' disponibile. Su quella tabella si puo' costruire il modello
semantico Power BI, per esempio con conteggi per cantiere, periodo e utente.
Anche tabella e report vanno protetti con le autorizzazioni/RLS appropriate.

## Limiti consapevoli della demo

- **Una sola replica e una sola revisione attiva**: sessioni, cache MSAL e
  coordinamento degli upload sono in memoria, con limiti e scadenze. Un riavvio
  richiede un nuovo login e il riavvio degli upload incompleti. I file gia'
  pubblicati rimangono in OneLake. Non aumentare le repliche senza introdurre
  storage condiviso per sessioni, token cache e stato degli upload.
- Un upload abbandonato scade dopo 30 minuti di inattivita'. Il server tenta di
  rimuovere il file temporaneo `.upload-<id>.part` e registra gli errori di
  pulizia. Dopo arresti improvvisi, revoche di permessi o errori di rete possono
  restare file temporanei in OneLake: sono nascosti dall'elenco dell'app e si
  possono rimuovere manualmente dopo aver verificato che non siano attivi.
- I retry recuperano errori di singole richieste, non un riavvio dell'app o una
  pagina chiusa. Mantieni il browser del telefono aperto durante l'upload.
- La firma iniziale identifica il formato; non e' una verifica completa del
  codec, una scansione antimalware, una moderazione o una transcodifica.
- La demo usa l'endpoint pubblico OneLake; reti private e tenant policy possono
  richiedere configurazione aggiuntiva.

## Diagnostica

| Sintomo | Verifica |
| --- | --- |
| Configurazione da completare / `/readyz` 503 | Variabili mancanti; riavvio dopo modifiche |
| `AADSTS50011` | Redirect Web identico ad `APP_BASE_URL` + `/auth/callback` |
| Login non riuscito | Tenant, client ID, **Value** del secret, scadenza, consenso, log Entra |
| Ritorno al login dopo il callback | HTTPS, `APP_BASE_URL`, cookie Secure e singola replica |
| `CSRF_REJECTED` (403) | Blocco locale prima di OneLake: versione client aggiornata, `APP_BASE_URL` uguale all'origine HTTPS del browser e sessione corrente. Non disabilitare i controlli CSRF |
| `ONELAKE_FORBIDDEN` (403) | Permessi dell'utente, ReadWrite, policy del tenant e rete |
| OneLake 404 | ID del workspace/Lakehouse e cartella `Files/demo` esistente |
| Preview non supportata | Codec/formato del browser; usa il download |
| Upload scaduto dopo deployment | Nuovo login e nuovo upload; non c'e' ripresa fra processi |

I log applicativi sono JSON su stdout/stderr con codici e riferimenti, senza
token, cookie, authorization code, secret o corpo dei file. Gli errori
dell'applicazione restituiscono un `requestId` da usare per la diagnosi.

## Riferimenti Microsoft

- [Creare un workspace Fabric](https://learn.microsoft.com/fabric/data-engineering/tutorial-lakehouse-get-started)
- [Connessione a OneLake: URI, GUID e audience Storage](https://learn.microsoft.com/fabric/onelake/onelake-access-api)
- [Compatibilita' OneLake con le API ADLS](https://learn.microsoft.com/fabric/onelake/onelake-api-parity)
- [Sicurezza OneLake e ReadWrite granulare](https://learn.microsoft.com/fabric/onelake/security/data-access-control-model)
- [Creare i ruoli OneLake](https://learn.microsoft.com/fabric/onelake/security/create-manage-roles)
- [MSAL Node: authorization code e token cache](https://learn.microsoft.com/entra/msal/javascript/node/acquire-token-requests)
- [SDK Data Lake JavaScript e TypeScript](https://learn.microsoft.com/javascript/api/overview/azure/storage-file-datalake-readme)
- [Deploy da GitHub Actions su Container Apps](https://learn.microsoft.com/azure/container-apps/github-actions)

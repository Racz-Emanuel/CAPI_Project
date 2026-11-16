# Mini Order Processing System

Aplicație demonstrativă de procesare asincronă a comenzilor, care folosește **Amazon SQS**, **Amazon EventBridge** și **Amazon SNS**. Totul rulează **local**, în Docker, pe un emulator AWS gratuit (**LocalStack**). Nu este nevoie de cont AWS, credențiale reale sau costuri.

Tehnologii: Node.js, JavaScript, Express.js, AWS SDK v3, Docker Compose, LocalStack, Postman.

---

## Cuprins

1. [Arhitectura](#1-arhitectura)
2. [Cerințe](#2-cerințe)
3. [Structura proiectului](#3-structura-proiectului)
4. [Instalare](#4-instalare)
5. [Pornirea LocalStack și a aplicației](#5-pornirea-localstack-și-a-aplicației)
6. [Configurare](#6-configurare)
7. [Utilizare](#7-utilizare)
8. [Operațiuni pe date: creare, inserare, citire, consumare, ștergere](#8-operațiuni-pe-date-creare-inserare-citire-consumare-ștergere)
9. [Scenariu complet de test](#9-scenariu-complet-de-test)
10. [Oprire și resetare](#10-oprire-și-resetare)

## 1. Arhitectura

```
Client / Postman / pagina web
        |
        v
   API Express  ───────────►  SQS  orders-queue  ──(după 3 eșecuri)──►  SQS orders-dlq
                                   |
                                   v
                               Worker
                                   |
                                   v
                    EventBridge  bus "orders-bus"
                                   |
                       regula "order-completed-rule"
                                   |
                                   v
                       SNS  topic "OrderNotifications"
                                   |
                                   v
                      SQS  notifications-queue
                                   |
                                   v
                     Notifier (în procesul API)
                      trimite notificarea, apoi șterge mesajul
```

Rolul serviciilor, pe scurt:

| Serviciu | Analogie | Rol în proiect |
|---|---|---|
| **SQS** | Cutie poștală | Păstrează comenzile până când worker-ul este gata; păstrează și notificările. Fiecare mesaj este preluat de un singur consumator. |
| **EventBridge** | Sortator inteligent | Primește evenimentul `OrderCompleted` și, pe baza unei reguli, îl trimite mai departe. |
| **SNS** | Difuzor | Trimite o copie a mesajului către toți abonații (aici: o coadă SQS; în realitate ar putea fi și email sau SMS). |

De ce toate trei:
- **SQS** separă API-ul de procesarea lentă. API-ul răspunde imediat, iar o comandă nu se pierde dacă worker-ul cade.
- **EventBridge** permite worker-ului să spună „s-a întâmplat ceva" fără să știe cine este interesat. Regulile decid destinațiile.
- **SNS** distribuie același mesaj către mai mulți destinatari.

---

## 2. Cerințe

- Windows 11 și PowerShell.
- **Docker Desktop** (https://www.docker.com/products/docker-desktop/), pornit, cu mesajul „Engine running".
- **Postman** (opțional, pentru testarea API-ului; același lucru se poate face cu `Invoke-RestMethod`).
- **AWS CLI** (opțional, necesar doar pentru secțiunea 8).

Verificare în PowerShell:

```powershell
docker --version
docker compose version
```

Instalarea AWS CLI (opțional):

```powershell
winget install -e --id Amazon.AWSCLI
```

După instalare, **închide și redeschide PowerShell**, apoi verifică cu `aws --version`.

---

## 3. Structura proiectului

```
mini-order-system/
  docker-compose.yml   pornește LocalStack, jobul de inițializare, API-ul și worker-ul
  Dockerfile           imaginea Node.js folosită de setup, api și worker
  .env.example         configurare (endpoint, regiune, credențiale dummy, port)
  .gitignore
  package.json         dependențe: 3 clienți AWS SDK v3 + express
  README.md            acest fișier
  public/
    index.html         pagina web simplă (formular + tabele)
  src/
    config.js          toate numele și setările
    aws.js             clienții SDK (îndreptați spre emulator) + funcția queueUrl
    setup-aws.js       creează toate resursele AWS; poate fi rulat de mai multe ori
    api.js             API REST + notifier + servește pagina web
    worker.js          citește din SQS, procesează, publică în EventBridge, șterge mesajul
```

---

## 4. Instalare

1. Creează folderul proiectului și copiază în el toate fișierele de mai sus, păstrând structura:

   ```powershell
   cd C:\Users\<numele-tau>\mini-order-system
   ```

2. Nu trebuie instalat Node.js pe Windows și nici `npm install` manual: dependențele se instalează automat în imaginea Docker la prima construire.

---

## 5. Pornirea LocalStack și a aplicației

Din folderul proiectului:

```powershell
docker compose up --build
```

Prima rulare durează câteva minute (descarcă imaginile și instalează dependențele). Docker Compose pornește, în ordine:

1. **localstack** – emulatorul AWS, pe portul 4566 (imaginea `localstack/localstack:4.14`, ultima versiune care nu cere cont sau token);
2. **setup** – job care creează toate resursele AWS și apoi se oprește;
3. **api** și **worker** – pornesc doar după ce `setup` s-a terminat cu succes.

Ar trebui să vezi în log:

```
setup-1   | [setup] SQS queues ready: ...
setup-1   | [setup] SNS topic ready: arn:aws:sns:us-east-1:000000000000:OrderNotifications
setup-1   | [setup] SNS -> notifications queue subscription ready
setup-1   | [setup] EventBridge bus ready: orders-bus
setup-1   | [setup] EventBridge rule + SNS target ready
setup-1   | [setup] DONE - all resources exist.
setup-1 exited with code 0
api-1     | [api] Listening on port 3000
api-1     | [notifier] Started. Polling http://localstack:4566/000000000000/notifications-queue
worker-1  | [worker] Started. Polling http://localstack:4566/000000000000/orders-queue
```

Verificarea stării LocalStack (într-o a doua fereastră PowerShell):

```powershell
Invoke-RestMethod http://localhost:4566/_localstack/health
```

Pornire în fundal și vizualizarea logurilor:

```powershell
docker compose up --build -d
docker compose logs -f worker
docker compose logs -f api
```

### De ce `localhost` nu merge în interiorul containerelor

`localhost` înseamnă „acest calculator". Pe Windows este laptopul tău, deci `http://localhost:4566` ajunge la LocalStack pentru că Compose publică portul 4566. În interiorul unui container, `localhost` este containerul însuși, unde nimic nu ascultă pe 4566. Containerele din același proiect Compose se găsesc după **numele serviciului**, de aceea aplicația folosește `http://localstack:4566`.

### Inițializarea resurselor

`setup-aws.js` creează automat, în această ordine, și poate fi rulat de câte ori vrei (resursele existente nu produc erori):

| Resursă | Nume |
|---|---|
| Coadă SQS pentru comenzi eșuate (dead-letter) | `orders-dlq` |
| Coadă SQS pentru comenzi (visibility timeout 10 s, după 3 încercări eșuate merge în `orders-dlq`) | `orders-queue` |
| Coadă SQS pentru notificări | `notifications-queue` |
| Topic SNS | `OrderNotifications` |
| Abonare a cozii de notificări la topic | – |
| Bus EventBridge personalizat | `orders-bus` |
| Regulă EventBridge (se potrivește pe `source: mini-order-system.worker` și `detail-type: OrderCompleted`) | `order-completed-rule` |
| Țintă a regulii | topicul SNS `OrderNotifications` |

---

## 6. Configurare

Setările se dau prin variabile de mediu (fișierul `.env.example`, citit de `docker-compose.yml`):

| Variabilă | Valoare implicită | Rol |
|---|---|---|
| `AWS_ENDPOINT_URL` | `http://localstack:4566` | Adresa emulatorului, văzută din interiorul Docker |
| `AWS_REGION` | `us-east-1` | Singura regiune folosită în tot proiectul |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | Credențiale dummy (SDK-ul cere unele; emulatorul nu le verifică) |
| `PORT` | `3000` | Portul API-ului |

Numele cozilor, topicului, bus-ului și regulii sunt în `src/config.js`.

---

## 7. Utilizare

### 7.1. Pagina web

Deschide **http://localhost:3000**. Pagina permite:

- trimiterea unei comenzi (formular);
- vizualizarea **comenzilor finalizate**, adică notificările SNS primite și consumate de notifier;
- vizualizarea **comenzilor eșuate** (coada dead-letter).

Se actualizează automat la 3 secunde.

### 7.2. API REST (Postman sau PowerShell)

#### Creare comandă – `POST /orders`

Postman: `POST http://localhost:3000/orders`, Body → raw → JSON:

```json
{ "customerName": "John", "product": "Laptop", "quantity": 1 }
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/orders -ContentType "application/json" -Body '{"customerName":"John","product":"Laptop","quantity":1}'
```

Răspuns așteptat – `202 Accepted`:

```json
{ "orderId": "3f1c9a4e-....", "message": "Order accepted and queued for processing" }
```

Comandă invalidă, de exemplu `{ "customerName": "", "quantity": 0 }` – `400 Bad Request`:

```json
{
  "error": "Invalid order",
  "details": [
    "customerName must be a non-empty string",
    "product must be a non-empty string",
    "quantity must be an integer >= 1"
  ]
}
```

JSON incorect (de exemplu `{bad`) – `400` cu `{ "error": "Body is not valid JSON" }`.

#### Citire notificări – `GET /notifications`

```powershell
Invoke-RestMethod http://localhost:3000/notifications | ConvertTo-Json -Depth 10
```

Returnează ultimele 10 notificări tratate de notifier (cele mai noi primele). Datele comenzii se află în `event.detail`:

```json
{
  "count": 1,
  "notifications": [
    {
      "topicArn": "arn:aws:sns:us-east-1:000000000000:OrderNotifications",
      "event": {
        "source": "mini-order-system.worker",
        "detail-type": "OrderCompleted",
        "detail": {
          "orderId": "3f1c9a4e-....",
          "customerName": "John",
          "product": "Laptop",
          "quantity": 1,
          "status": "COMPLETED",
          "timestamp": "2026-..."
        }
      }
    }
  ]
}
```

Lista este ținută în memorie: dacă repornești API-ul, se golește.

#### Comenzi eșuate – `GET /failed-orders`

```powershell
Invoke-RestMethod http://localhost:3000/failed-orders
```

Pentru a produce un eșec, trimite o comandă cu produsul `FAIL`. Worker-ul o va încerca de 3 ori (la ~10 secunde distanță), apoi SQS o mută în `orders-dlq`, iar ea apare aici.

#### Verificare stare – `GET /health`

```powershell
Invoke-RestMethod http://localhost:3000/health
```

### 7.3. Loguri așteptate

Comandă reușită, în `docker compose logs -f worker`:

```
[worker] Processing order 3f1c... (1 x Laptop for John), attempt #1
[worker] Order 3f1c... processed. Publishing OrderCompleted event...
[worker] OrderCompleted event published for 3f1c...
[worker] Message deleted from queue for order 3f1c...
```

Și în `docker compose logs -f api`:

```
[api] Order 3f1c... sent to SQS
[notifier] Notification sent: order 3f1c... for John is COMPLETED
```

Comandă eșuată (produs `FAIL`):

```
[worker] Processing FAILED, message left in queue for retry: Simulated processing failure
```

repetat de 3 ori, apoi comanda ajunge în `orders-dlq`.

---

## 8. Operațiuni pe date: creare, inserare, citire, consumare, ștergere

Aceste comenzi lucrează direct cu emulatorul, prin AWS CLI, ca să vezi ce se întâmplă în fiecare serviciu. Rulează-le în PowerShell, cât timp `docker compose up` este pornit.

### 8.0. Pregătire (o dată per fereastră PowerShell)

```powershell
$env:AWS_ACCESS_KEY_ID = "test"
$env:AWS_SECRET_ACCESS_KEY = "test"
$env:AWS_DEFAULT_REGION = "us-east-1"
$Q = "http://localhost:4566/000000000000"

function awsl { aws --endpoint-url=http://localhost:4566 @args }
```

De aici înainte, `awsl` înseamnă „AWS CLI îndreptat spre LocalStack". Din PowerShell, adresa emulatorului este `localhost` (nu `localstack`), pentru că rulezi comenzile pe Windows.

### 8.1. SQS

**Listare cozi**

```powershell
awsl sqs list-queues
```

**Creare coadă** (exemplu; cozile proiectului există deja)

```powershell
awsl sqs create-queue --queue-name test-queue
```

Comanda este repetabilă: dacă există, o returnează pe cea existentă.

**Câte mesaje are o coadă**

```powershell
awsl sqs get-queue-attributes --queue-url "$Q/orders-queue" --attribute-names ApproximateNumberOfMessages
```

**Inserare mesaj într-o coadă**

Ca să vezi mesajele în coadă, oprește mai întâi worker-ul, altfel le consumă imediat:

```powershell
docker compose stop worker
```

Varianta simplă – prin API:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/orders -ContentType "application/json" -Body '{"customerName":"Maria","product":"Telefon","quantity":2}'
```

Varianta directă în SQS (creezi un fișier JSON, ca să nu ai probleme cu ghilimelele în PowerShell):

```powershell
@'
{"QueueUrl":"http://localhost:4566/000000000000/orders-queue","MessageBody":"{\"orderId\":\"manual-1\",\"customerName\":\"Maria\",\"product\":\"Telefon\",\"quantity\":2}"}
'@ | Set-Content -Encoding ascii msg.json

awsl sqs send-message --cli-input-json file://msg.json
```

`-Encoding ascii` este important: în Windows PowerShell 5.1, codarea implicită adaugă un caracter invizibil (BOM) care strică JSON-ul.

**Citire fără consumare („peek")** – mesajul rămâne în coadă:

```powershell
awsl sqs receive-message --queue-url "$Q/orders-queue" --visibility-timeout 0 --max-number-of-messages 5
```

**Consumare și ștergere** – citești mesajul, apoi îl ștergi pe baza `ReceiptHandle`:

```powershell
$rh = awsl sqs receive-message --queue-url "$Q/orders-queue" --query 'Messages[0].ReceiptHandle' --output text
awsl sqs delete-message --queue-url "$Q/orders-queue" --receipt-handle $rh
```

Dacă nu ștergi mesajul după citire, el reapare în coadă după *visibility timeout* (10 secunde pentru `orders-queue`). „Ștergerea" este modul în care un consumator confirmă că a procesat mesajul.

**Repornește worker-ul** și urmărește cum procesează mesajele rămase:

```powershell
docker compose start worker
docker compose logs -f worker
```

**Golirea unei cozi** (șterge toate mesajele):

```powershell
awsl sqs purge-queue --queue-url "$Q/test-queue"
```

**Ștergerea unei cozi** (doar pentru coada de test; nu șterge cozile proiectului):

```powershell
awsl sqs delete-queue --queue-url "$Q/test-queue"
```

**Citirea comenzilor eșuate din dead-letter queue:**

```powershell
awsl sqs receive-message --queue-url "$Q/orders-dlq" --visibility-timeout 0
```

### 8.2. SNS

**Listare topicuri și abonamente**

```powershell
awsl sns list-topics
awsl sns list-subscriptions
```

Ar trebui să vezi `OrderNotifications` și un abonament cu protocolul `sqs`, către `notifications-queue`.

**Publicare directă a unui mesaj pe topic** (fără EventBridge):

```powershell
awsl sns publish --topic-arn arn:aws:sns:us-east-1:000000000000:OrderNotifications --message "mesaj de test"
```

Notifier-ul din API consumă imediat mesajele din `notifications-queue`. Ca să le vezi în coadă și să le consumi manual, oprește API-ul:

```powershell
docker compose stop api
awsl sns publish --topic-arn arn:aws:sns:us-east-1:000000000000:OrderNotifications --message "mesaj de test"

# citire (peek)
awsl sqs receive-message --queue-url "$Q/notifications-queue" --visibility-timeout 0

# consumare + ștergere
$rh = awsl sqs receive-message --queue-url "$Q/notifications-queue" --query 'Messages[0].ReceiptHandle' --output text
awsl sqs delete-message --queue-url "$Q/notifications-queue" --receipt-handle $rh

# pornește din nou API-ul
docker compose start api
```

Mesajul din coadă are un „plic" SNS în jurul conținutului: câmpul `Message` conține textul publicat (pentru evenimentele EventBridge, un JSON ca text).

**Creare topic** (exemplu): `awsl sns create-topic --name TopicTest`. **Ștergere:** `awsl sns delete-topic --topic-arn arn:aws:sns:us-east-1:000000000000:TopicTest`.

### 8.3. EventBridge

**Listare bus-uri, reguli și ținte**

```powershell
awsl events list-event-buses
awsl events list-rules --event-bus-name orders-bus
awsl events describe-rule --name order-completed-rule --event-bus-name orders-bus
awsl events list-targets-by-rule --rule order-completed-rule --event-bus-name orders-bus
```

Ar trebui să vezi regula `order-completed-rule` (`ENABLED`), cu modelul `{"source":["mini-order-system.worker"],"detail-type":["OrderCompleted"]}` și ținta `arn:aws:sns:us-east-1:000000000000:OrderNotifications`.

**Publicarea manuală a unui eveniment** (exact ce face worker-ul):

```powershell
@'
[{"EventBusName":"orders-bus","Source":"mini-order-system.worker","DetailType":"OrderCompleted","Detail":"{\"orderId\":\"manual-2\",\"customerName\":\"Ion\",\"product\":\"Tableta\",\"quantity\":1,\"status\":\"COMPLETED\",\"timestamp\":\"2026-01-01T10:00:00Z\"}"}]
'@ | Set-Content -Encoding ascii event.json

awsl events put-events --entries file://event.json
```

Dacă regula funcționează, în 5 secunde apare o notificare nouă în `http://localhost:3000/notifications` și în pagina web. `FailedEntryCount: 0` în răspuns înseamnă că EventBridge a acceptat evenimentul.

**Ștergerea resurselor EventBridge** (nu este nevoie în mod normal; `setup` le recreează):

```powershell
awsl events remove-targets --rule order-completed-rule --event-bus-name orders-bus --ids sns-target
awsl events delete-rule --name order-completed-rule --event-bus-name orders-bus
awsl events delete-event-bus --name orders-bus
```

Resursele șterse manual se recreează rulând din nou: `docker compose run --rm setup`.

### 8.4. Alternativă fără AWS CLI pe Windows

Imaginea LocalStack are propria comandă `awslocal`:

```powershell
docker compose exec localstack awslocal sqs list-queues
```

(în acest caz nu mai ai nevoie de `$Q` și `awsl`; folosește adrese de forma `http://localhost:4566/000000000000/orders-queue`.)

---

## 9. Scenariu complet de test

1. `docker compose up --build` și așteaptă `[worker] Started`.
2. Deschide http://localhost:3000 și trimite comanda John / Laptop / 1.
3. În `docker compose logs -f worker` apar cele 4 linii de procesare.
4. În 3–8 secunde, comanda apare în tabelul „Completed orders" și în `docker compose logs -f api` apare linia `[notifier] Notification sent: ...`. Asta dovedește tot lanțul: **API → SQS → Worker → EventBridge → SNS → SQS → Notifier**.
5. Trimite o comandă cu produsul `FAIL`. După ~30 de secunde apare în „Failed orders".
6. Trimite o comandă invalidă (cantitate 0) și verifică răspunsul `400`.
7. (Opțional) Oprește worker-ul, trimite 2 comenzi, verifică cu `get-queue-attributes` că sunt 2 mesaje, citește-le cu peek, repornește worker-ul și urmărește cum se golește coada.

Listă de verificare:

- [ ] `setup` s-a terminat cu `exited with code 0`
- [ ] `POST /orders` returnează 202 cu `orderId`
- [ ] Worker-ul loghează `Message deleted from queue`
- [ ] Apare linia `[notifier] Notification sent`
- [ ] Comanda apare în pagina web
- [ ] Comanda `FAIL` ajunge în `/failed-orders`
- [ ] Comanda invalidă returnează 400

---

## 10. Oprire și resetare

Oprire (Ctrl+C dacă rulează în prim-plan), apoi:

```powershell
docker compose down
```

Resetare completă (șterge containerele și imaginile construite local):

```powershell
docker compose down --volumes --rmi local
```

LocalStack nu păstrează date între rulări, deci `docker compose down` urmat de `docker compose up --build` dă oricum o stare curată, cu resursele recreate automat.

Reconstruire după modificarea codului: `docker compose up --build`.

---


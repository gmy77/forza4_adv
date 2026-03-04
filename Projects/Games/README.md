# 🔴🟡 Forza 4 — Advanced Edition

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.8%2B-blue?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Pygame-2.5%2B-green?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Browser-HTML5%20Canvas-orange?logo=html5&logoColor=white" />
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Web-lightgrey" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" />
</p>

<p align="center">
  Versione avanzata del classico <strong>Forza 4</strong> — disponibile come app desktop (Python/Pygame)<br/>
  e come <strong>gioco browser</strong> integrato nel progetto ECHO su Cloudflare Workers.<br/>
  Grafica moderna, animazioni fluide, particelle, effetti 3D e <strong>avversario AI con Minimax</strong>.
</p>

<p align="center">
  <a href="https://sismo-fvg.gimmy077.workers.dev/forza4"><strong>🎮 Gioca nel browser →</strong></a>
</p>

---

## 🖥️ Due versioni

| | Desktop (Python) | Browser (Web) |
|---|---|---|
| **File** | `forza4.py` | [sismo-fvg.gimmy077.workers.dev/forza4](https://sismo-fvg.gimmy077.workers.dev/forza4) |
| **Tecnologia** | Python + Pygame | HTML5 Canvas + Vanilla JS |
| **Piattaforma** | Windows / Linux / macOS | Qualsiasi browser moderno |
| **AI avversario** | ❌ Solo 2 giocatori | ✅ Minimax depth 6 + alpha-beta |
| **Installazione** | Richiede Python + Pygame | Nessuna — apri e gioca |
| **Hosting** | Locale | Cloudflare Workers (edge global) |

---

## ✨ Funzionalità

| Feature | Desktop | Browser |
|---------|---------|---------|
| 🎨 **Grafica avanzata** — pezzi 3D con highlight radiale e ombra | ✅ | ✅ |
| 🌊 **Animazione caduta** — gravità realistica frame-independente | ✅ | ✅ |
| ✨ **Sistema particelle** — esplosione all'impatto e alla vittoria | ✅ | ✅ |
| 🏆 **Celle vincenti** — lampeggiano con animazione pulsante | ✅ | ✅ |
| 👆 **Hover preview** — anteprima pezzo con freccia animata | ✅ | ✅ |
| 📊 **Punteggi persistenti** — mantenuti tra le partite | ✅ | ✅ |
| 🔄 **Flash reset** — feedback visivo ciano al "Nuova partita" | ❌ | ✅ |
| 🤖 **AI Minimax** — avversario CPU con alpha-beta pruning depth 6 | ❌ | ✅ |
| 📱 **Touch support** — giocabile su smartphone e tablet | ❌ | ✅ |
| 🌐 **Zero installazione** — funziona direttamente nel browser | ❌ | ✅ |

---

## 🤖 Intelligenza Artificiale (versione browser)

La modalità **vs CPU** utilizza l'algoritmo **Minimax con Alpha-Beta Pruning**:

- **Depth 6** — analizza fino a 6 mosse in avanti
- **Alpha-beta pruning** — riduce drasticamente i nodi esplorati
- **Move ordering** — privilegia le colonne centrali (strategia ottimale per Forza 4)
- **Funzione euristica** — valuta finestre di 4 celle pesando sequenze da 2, 3 e 4 pezzi
- **Difficoltà:** media-alta — sa bloccare, costruire trappole e sfruttare diagonali

```
Attiva con il bottone  [ vs CPU: OFF ] → [ vs CPU: ON 🤖 ]
```

---

## 🚀 Versione Desktop — Installazione

### 1. Clona il repository

```bash
git clone https://github.com/gmy77/forza4_adv.git
cd forza4_adv
```

### 2. Installa la dipendenza

```bash
pip install pygame
```

### 3. Avvia il gioco

```bash
python forza4.py
```

---

## 🎮 Controlli

### Desktop (Python)

| Azione | Input |
|--------|-------|
| **Posizionare un pezzo** | Click sinistro sulla colonna |
| **Nuova partita** | Tasto `R` |
| **Uscire** | Tasto `Q` o chiudi la finestra |

### Browser

| Azione | Input |
|--------|-------|
| **Posizionare un pezzo** | Click / tap sulla colonna |
| **Hover preview** | Muovi il mouse sulla board |
| **Nuova partita** | Bottone "↺ Nuova partita" o tasto `R` |
| **Attivare AI** | Bottone "vs CPU: OFF" → "vs CPU: ON 🤖" |
| **Tornare al monitor ECHO** | Bottone "← ECHO Monitor" |

---

## 🏗️ Struttura del codice

### Desktop (`forza4.py`)

```
forza4.py
├── class Particle          # Particella fisica (posizione, velocità, fade-out)
└── class ForzeQuattro      # Motore di gioco principale
    ├── reset()             # Reimposta stato partita
    ├── update(dt)          # Aggiorna fisica, animazioni e particelle
    ├── draw()              # Rendering: sfondo → pezzi → tavola → UI
    ├── drop_piece(col)     # Avvia animazione caduta pezzo
    ├── check_winner(p)     # Controlla vittoria (4 direzioni)
    └── run()               # Game loop principale (60 FPS)
```

### Browser (`sismo-worker/index.js` — Cloudflare Worker)

```
renderForza4()              # Restituisce HTML+JS come stringa
├── initCvs()               # Sizing responsive del canvas
├── reset()                 # Reset stato + flash visivo
├── dropPiece(col)          # Animazione caduta con gravità
├── chkWin(pl)              # Rilevamento vittoria 4 direzioni
├── drawBoard()             # Rendering board con buchi
├── drawPiece(x,y,pl,al)   # Pezzo 3D con gradiente radiale
├── drawHov()               # Preview hover con freccia animata
├── drawEnd()               # Overlay vittoria/pareggio
├── update(dt) / draw()     # Game loop con requestAnimationFrame
├── sc4() / bdSc()          # Funzione euristica AI
├── winOn() / mm()          # Minimax con alpha-beta pruning
└── aiMove()                # Esegue mossa ottimale CPU
```

---

## 🎨 Dettagli tecnici

### Desktop
- **Risoluzione:** 820 × 790 px — adattabile via costanti
- **FPS target:** 60 con delta-time frame-indipendente
- **Rendering pezzi:** bordo scuro → colore base → highlight radiale → punto luce

### Browser
- **Canvas:** responsive, max 720px, si adatta a mobile
- **Tema:** dark ECHO (`#080e14`) con accenti ciano `#26c6da`
- **Hosting:** Cloudflare Workers edge — latenza globale minima
- **Compatibilità:** Chrome, Edge, Firefox, Safari, mobile

---

## 🛠️ Personalizzazione (Desktop)

```python
COLS      = 7       # Colonne
ROWS      = 6       # Righe
CELL_SIZE = 100     # Dimensione cella in pixel
FPS       = 60      # Frame per secondo
```

---

## 🌐 Integrazione ECHO Monitor

La versione browser è integrata nel progetto **ECHO Monitor** — sistema di monitoraggio sismico FVG con correlazione dati solari:

- **Dashboard ECHO:** [sismo-fvg.gimmy077.workers.dev](https://sismo-fvg.gimmy077.workers.dev)
- **Pannello ECHO Games** nella dashboard principale
- **Forza 4:** [sismo-fvg.gimmy077.workers.dev/forza4](https://sismo-fvg.gimmy077.workers.dev/forza4)

---

## 📄 Licenza

Distribuito sotto licenza **MIT**. Libero di usare, modificare e distribuire.

---

<p align="center">
  Fatto con ❤️ da <strong>Gimmy</strong> — Desktop: Python/Pygame · Browser: Cloudflare Workers
</p>

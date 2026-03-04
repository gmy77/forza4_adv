# 🔴🟡 Forza 4 — Advanced Edition

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.8%2B-blue?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Pygame-2.5%2B-green?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" />
</p>

<p align="center">
  Versione avanzata del classico <strong>Forza 4</strong> realizzata in Python con Pygame.<br/>
  Grafica moderna, animazioni fluide, particelle ed effetti visivi 3D.
</p>

---

## Anteprima

```
╔═══════════════════════════════════════╗
║            FORZA  4                   ║
║  [G1: Rosso  0]        [G2: Giallo 0] ║
║                                       ║
║  🔴 🔴 ⬛ ⬛ ⬛ ⬛ ⬛              ║
║  🔴 🟡 🟡 ⬛ ⬛ ⬛ ⬛              ║
║  🔴 🟡 🔴 🟡 ⬛ ⬛ ⬛              ║
║  🟡 🔴 🟡 🔴 🟡 ⬛ ⬛              ║
╚═══════════════════════════════════════╝
```

---

## ✨ Funzionalità

| Feature | Descrizione |
|---------|-------------|
| 🎨 **Grafica avanzata** | Sfondo con gradiente, pezzi con effetto 3D (highlight + ombreggiatura + riflesso) |
| 🌊 **Animazione caduta** | I pezzi cadono con accelerazione gravitazionale realistica |
| ✨ **Sistema particelle** | Esplosione di particelle all'impatto e alla vittoria |
| 🏆 **Celle vincenti** | Le 4 celle vittoria lampeggiano con animazione pulsante |
| 👆 **Hover preview** | Anteprima del pezzo con freccia animata sulla colonna selezionata |
| 📊 **Punteggi persistenti** | I punteggi vengono mantenuti tra le partite senza riavviare |
| 🎯 **Rilevamento completo** | Vittoria in orizzontale, verticale e diagonale (entrambe le direzioni) |
| 🔄 **Reset rapido** | Nuova partita con un tasto, senza perdere il punteggio |

---

## 📦 Requisiti

- **Python** 3.8 o superiore
- **Pygame** 2.5 o superiore

---

## 🚀 Installazione e avvio

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

| Azione | Input |
|--------|-------|
| **Posizionare un pezzo** | Click sinistro del mouse sulla colonna desiderata |
| **Nuova partita** | Tasto `R` |
| **Uscire** | Tasto `Q` oppure chiudi la finestra |

---

## 🏗️ Struttura del codice

```
forza4.py
├── class Particle          # Singola particella (posizione, fisica, rendering)
└── class ForzeQuattro      # Motore di gioco principale
    ├── reset()             # Reimposta lo stato della partita
    ├── update(dt)          # Aggiorna fisica, animazioni e particelle
    ├── draw()              # Rendering principale (sfondo → pezzi → tavola → UI)
    ├── drop_piece(col)     # Avvia animazione di caduta pezzo
    ├── check_winner(p)     # Controlla vittoria (orizzontale/verticale/diagonale)
    └── run()               # Game loop principale
```

---

## 🎨 Dettagli tecnici

- **Risoluzione:** 820 × 790 pixel (adattabile modificando le costanti)
- **FPS target:** 60 fps con delta-time per animazioni frame-indipendenti
- **Griglia:** 7 colonne × 6 righe (standard internazionale del Forza 4)
- **Rendering pezzi:** Multi-layer (bordo scuro → colore base → highlight radiale → punto luce)
- **Particelle:** Fisica con gravità, fade-out per alpha e riduzione dimensione

---

## 🛠️ Personalizzazione

Le costanti all'inizio del file permettono di adattare facilmente il gioco:

```python
COLS      = 7       # Numero di colonne
ROWS      = 6       # Numero di righe
CELL_SIZE = 100     # Dimensione cella in pixel
FPS       = 60      # Frame per secondo
```

---

## 📄 Licenza

Distribuito sotto licenza **MIT**. Libero di usare, modificare e distribuire.

---

<p align="center">
  Fatto con ❤️ e Pygame da <strong>Gimmy</strong>
</p>

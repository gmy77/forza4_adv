#!/usr/bin/env python3
"""
FORZA 4 - Versione con grafica avanzata
Autore: Gimmy
Descrizione: Gioco Forza 4 a due giocatori con animazioni, particelle e effetti visivi
"""

import pygame
import sys
import math
import random
import time

# ─── Costanti di gioco ───────────────────────────────────────────────────────
COLS        = 7
ROWS        = 6
CELL_SIZE   = 100
MARGIN      = 60
TOP_MARGIN  = 160
RADIUS      = CELL_SIZE // 2 - 8
WIDTH       = COLS * CELL_SIZE + MARGIN * 2
HEIGHT      = ROWS * CELL_SIZE + TOP_MARGIN + MARGIN + 20
FPS         = 60

# ─── Palette colori ──────────────────────────────────────────────────────────
WHITE        = (255, 255, 255)
BLACK        = (0,   0,   0)
GRAY         = (150, 150, 150)
GRAY_DARK    = (60,  60,  80)

BG_TOP       = (8,  10,  40)
BG_BOTTOM    = (25, 15,  65)

BOARD_MAIN   = (25,  50, 170)
BOARD_EDGE   = (55,  90, 220)
HOLE_DARK    = (5,   8,  30)

RED          = (220, 50,  50)
RED_LIGHT    = (255, 110, 110)
RED_DARK     = (140, 25,  25)

YELLOW       = (255, 210, 0)
YELLOW_LIGHT = (255, 245, 110)
YELLOW_DARK  = (175, 135, 0)

GREEN        = (50,  210, 80)
CYAN         = (80,  220, 255)


# ─── Particella ──────────────────────────────────────────────────────────────
class Particle:
    def __init__(self, x, y, color):
        self.x        = float(x)
        self.y        = float(y)
        self.color    = color
        self.vx       = random.uniform(-6, 6)
        self.vy       = random.uniform(-12, -3)
        self.lifetime = random.uniform(0.8, 1.8)
        self.age      = 0.0
        self.size     = random.uniform(4, 10)

    def update(self, dt):
        self.age += dt
        self.vy  += 30 * dt
        self.x   += self.vx
        self.y   += self.vy
        self.size = max(0, self.size * (1 - dt * 1.5))

    def draw(self, surface):
        if self.age >= self.lifetime or self.size < 0.5:
            return
        alpha = max(0, int(255 * (1 - self.age / self.lifetime)))
        s = pygame.Surface((int(self.size * 2 + 2), int(self.size * 2 + 2)), pygame.SRCALPHA)
        r, g, b = self.color
        pygame.draw.circle(s, (r, g, b, alpha),
                           (int(self.size) + 1, int(self.size) + 1), int(self.size))
        surface.blit(s, (int(self.x - self.size), int(self.y - self.size)))

    @property
    def alive(self):
        return self.age < self.lifetime and self.size > 0.5


# ─── Gioco principale ────────────────────────────────────────────────────────
class ForzeQuattro:

    def __init__(self):
        pygame.init()
        pygame.display.set_caption("⭕ FORZA 4 ⭕")
        self.screen = pygame.display.set_mode((WIDTH, HEIGHT))
        self.clock  = pygame.time.Clock()

        # Font
        self.font_title  = pygame.font.SysFont("Arial", 68, bold=True)
        self.font_large  = pygame.font.SysFont("Arial", 50, bold=True)
        self.font_medium = pygame.font.SysFont("Arial", 34, bold=False)
        self.font_small  = pygame.font.SysFont("Arial", 26)

        # Superfici pre-calcolate
        self._bg_surf    = self._make_bg()
        self._board_mask = self._make_board_mask()

        # Punteggi persistenti
        self.score = [0, 0]

        self.reset()

    # ── Stato ────────────────────────────────────────────────────────────────

    def reset(self):
        self.board          = [[0] * COLS for _ in range(ROWS)]
        self.current_player = 1
        self.game_over      = False
        self.winner         = 0
        self.winning_cells  = []
        self.hover_col      = -1
        self.particles      = []
        self.win_timer      = 0.0
        self.drop_anim      = None   # [col, target_row, cur_y, speed, player]

    # ── Superfici pre-calcolate ───────────────────────────────────────────────

    def _make_bg(self):
        surf = pygame.Surface((WIDTH, HEIGHT))
        for y in range(HEIGHT):
            t = y / HEIGHT
            r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
            g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
            b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
            pygame.draw.line(surf, (r, g, b), (0, y), (WIDTH, y))
        return surf

    def _make_board_mask(self):
        """Maschera trasparente che ritaglia i buchi dalla tavola."""
        surf = pygame.Surface((COLS * CELL_SIZE, ROWS * CELL_SIZE + 20), pygame.SRCALPHA)
        surf.fill((*BOARD_MAIN, 255))
        for row in range(ROWS):
            for col in range(COLS):
                cx = col * CELL_SIZE + CELL_SIZE // 2
                cy = 10 + row * CELL_SIZE + CELL_SIZE // 2
                pygame.draw.circle(surf, (0, 0, 0, 0), (cx, cy), RADIUS + 4)
        return surf

    # ── Helper posizioni ─────────────────────────────────────────────────────

    def bx(self, col):
        return MARGIN + col * CELL_SIZE + CELL_SIZE // 2

    def by(self, row):
        return TOP_MARGIN + 10 + row * CELL_SIZE + CELL_SIZE // 2

    # ── Logica ───────────────────────────────────────────────────────────────

    def next_empty_row(self, col):
        for row in range(ROWS - 1, -1, -1):
            if self.board[row][col] == 0:
                return row
        return -1

    def check_winner(self, player):
        b = self.board

        def check_line(cells):
            return [(r, c) for r, c in cells if b[r][c] == player] \
                if all(b[r][c] == player for r, c in cells) else []

        for r in range(ROWS):
            for c in range(COLS - 3):
                res = check_line([(r, c + i) for i in range(4)])
                if res:
                    return res
        for r in range(ROWS - 3):
            for c in range(COLS):
                res = check_line([(r + i, c) for i in range(4)])
                if res:
                    return res
        for r in range(3, ROWS):
            for c in range(COLS - 3):
                res = check_line([(r - i, c + i) for i in range(4)])
                if res:
                    return res
        for r in range(ROWS - 3):
            for c in range(COLS - 3):
                res = check_line([(r + i, c + i) for i in range(4)])
                if res:
                    return res
        return []

    def board_full(self):
        return all(self.board[0][c] != 0 for c in range(COLS))

    def drop_piece(self, col):
        if self.game_over or self.drop_anim is not None:
            return
        row = self.next_empty_row(col)
        if row == -1:
            return
        start_y = float(TOP_MARGIN - 60)
        self.drop_anim = [col, row, start_y, 8.0, self.current_player]

    # ── Update ───────────────────────────────────────────────────────────────

    def update(self, dt):
        # Animazione caduta
        if self.drop_anim:
            col, target_row, cur_y, speed, player = self.drop_anim
            target_y = float(self.by(target_row))

            speed  += 55 * dt
            cur_y  += speed

            if cur_y >= target_y:
                cur_y = target_y
                self.drop_anim = None
                self.board[target_row][col] = player

                # Particelle d'impatto
                cx = self.bx(col)
                cy = self.by(target_row)
                c  = RED if player == 1 else YELLOW
                for _ in range(14):
                    self.particles.append(Particle(cx, cy, c))

                # Controllo vittoria
                win = self.check_winner(player)
                if win:
                    self.game_over     = True
                    self.winner        = player
                    self.winning_cells = win
                    self.score[player - 1] += 1
                    for rw, cw in win:
                        for _ in range(22):
                            self.particles.append(
                                Particle(self.bx(cw), self.by(rw), c))
                elif self.board_full():
                    self.game_over = True
                    self.winner    = 0
                else:
                    self.current_player = 3 - player
            else:
                self.drop_anim[2] = cur_y
                self.drop_anim[3] = speed

        # Particelle
        for p in self.particles:
            p.update(dt)
        self.particles = [p for p in self.particles if p.alive]

        # Timer vittoria (per lampeggio)
        if self.game_over and self.winner:
            self.win_timer += dt

    # ── Draw pezzi ───────────────────────────────────────────────────────────

    def draw_coin(self, surface, cx, cy, player, flash=1.0, alpha=255):
        """Disegna un pezzo con effetto 3D."""
        if player == 1:
            main, light, dark = RED, RED_LIGHT, RED_DARK
        else:
            main, light, dark = YELLOW, YELLOW_LIGHT, YELLOW_DARK

        # Mescola con bianco per lampeggio
        if flash < 1.0:
            main  = tuple(min(255, int(main[i]  * flash + 255 * (1 - flash))) for i in range(3))
            light = tuple(min(255, int(light[i] * flash + 255 * (1 - flash))) for i in range(3))

        # Ombra sotto
        sh = pygame.Surface((RADIUS * 2 + 10, RADIUS * 2 + 10), pygame.SRCALPHA)
        pygame.draw.circle(sh, (0, 0, 0, 90), (RADIUS + 8, RADIUS + 8), RADIUS)
        surface.blit(sh, (cx - RADIUS - 3, cy - RADIUS + 3))

        # Bordo / volume
        pygame.draw.circle(surface, dark, (cx, cy), RADIUS)
        pygame.draw.circle(surface, main, (cx, cy), RADIUS - 2)

        # Luce principale (riflesso ampio)
        hl = pygame.Surface((RADIUS * 2, RADIUS * 2), pygame.SRCALPHA)
        for i in range(RADIUS // 2, 0, -2):
            a = int(90 * (1 - i / (RADIUS // 2)))
            pygame.draw.circle(hl, (*light, a),
                               (RADIUS // 2 - 2, RADIUS // 2 - 2), i)
        surface.blit(hl, (cx - RADIUS, cy - RADIUS))

        # Puntino bianco brillante
        pygame.draw.circle(surface, light, (cx - RADIUS // 4, cy - RADIUS // 4), RADIUS // 5)
        pygame.draw.circle(surface, WHITE,  (cx - RADIUS // 4 - 2, cy - RADIUS // 4 - 2), RADIUS // 9)

    # ── Draw principale ──────────────────────────────────────────────────────

    def draw(self):
        # Sfondo gradiente
        self.screen.blit(self._bg_surf, (0, 0))

        self._draw_title()
        self._draw_player_panels()

        # Pezzi a terra (già nel board)
        for row in range(ROWS):
            for col in range(COLS):
                cell = self.board[row][col]
                if cell and not (self.drop_anim and
                                 self.drop_anim[0] == col and
                                 self.drop_anim[1] == row and
                                 self.drop_anim[2] == self.by(row)):
                    in_win = (row, col) in self.winning_cells
                    flash  = 1.0
                    if in_win and self.win_timer > 0:
                        flash = 0.3 + 0.7 * abs(math.sin(self.win_timer * 5))
                    self.draw_coin(self.screen, self.bx(col), self.by(row), cell, flash)

        # Tavola sopra i pezzi
        self.screen.blit(self._board_mask, (MARGIN, TOP_MARGIN))
        # Bordo tavola
        brd = pygame.Rect(MARGIN, TOP_MARGIN, COLS * CELL_SIZE, ROWS * CELL_SIZE + 20)
        pygame.draw.rect(self.screen, BOARD_EDGE, brd, width=3, border_radius=12)

        # Animazione caduta (davanti alla tavola)
        if self.drop_anim:
            col, _, cur_y, _, player = self.drop_anim
            self.draw_coin(self.screen, self.bx(col), int(cur_y), player)

        # Hover preview
        self._draw_hover()

        # Particelle
        for p in self.particles:
            p.draw(self.screen)

        # Overlay fine partita
        if self.game_over:
            self._draw_endgame()

    def _draw_title(self):
        t = pygame.time.get_ticks() / 1000
        # Leggera oscillazione colore
        wave = 0.5 + 0.5 * math.sin(t * 2)
        r = int(RED[0] * wave + YELLOW[0] * (1 - wave))
        g = int(RED[1] * wave + YELLOW[1] * (1 - wave))
        b = int(RED[2] * wave + YELLOW[2] * (1 - wave))

        title    = self.font_title.render("FORZA  4", True, (r, g, b))
        shadow   = self.font_title.render("FORZA  4", True, (20, 10, 40))
        tx       = WIDTH // 2 - title.get_width() // 2
        self.screen.blit(shadow, (tx + 4, 14))
        self.screen.blit(title,  (tx, 10))

        # Linee decorative ai lati
        lw = 90
        pygame.draw.line(self.screen, RED,    (tx - 20, 70), (tx - 20 + lw, 70), 3)
        pygame.draw.line(self.screen, YELLOW, (tx + title.get_width() - lw + 20, 70),
                         (tx + title.get_width() + 20, 70), 3)

    def _draw_player_panels(self):
        for p in (1, 2):
            active = (self.current_player == p and
                      not self.game_over and
                      self.drop_anim is None)
            color  = RED if p == 1 else YELLOW
            name   = f"G{p}: Rosso" if p == 1 else f"G{p}: Giallo"
            x      = 15 if p == 1 else WIDTH - 185
            y      = 82

            # Pannello
            rect = pygame.Rect(x, y, 170, 58)
            bg   = pygame.Surface((170, 58), pygame.SRCALPHA)
            bg.fill((*color, 25) if active else (30, 20, 50, 200))
            self.screen.blit(bg, rect.topleft)
            pygame.draw.rect(self.screen, color if active else GRAY_DARK,
                             rect, width=2, border_radius=10)

            # Mini pezzo
            self.draw_coin(self.screen, x + 22, y + 29, p)

            # Testo nome
            txt = self.font_small.render(name, True, WHITE if active else GRAY)
            self.screen.blit(txt, (x + 42, y + 8))

            # Punteggio
            pts = self.font_medium.render(str(self.score[p - 1]), True, color)
            self.screen.blit(pts, (x + 42, y + 30))

    def _draw_hover(self):
        if self.hover_col < 0 or self.game_over or self.drop_anim is not None:
            return
        cx = self.bx(self.hover_col)
        cy = TOP_MARGIN - 50
        t  = pygame.time.get_ticks() / 1000
        cy += int(math.sin(t * 4) * 6)

        surf = pygame.Surface((RADIUS * 2 + 10, RADIUS * 2 + 10), pygame.SRCALPHA)
        c = RED if self.current_player == 1 else YELLOW
        pygame.draw.circle(surf, (*c, 170), (RADIUS + 5, RADIUS + 5), RADIUS - 1)
        # mini highlight
        pygame.draw.circle(surf, (*WHITE, 120),
                           (RADIUS + 5 - RADIUS // 4, RADIUS + 5 - RADIUS // 4),
                           RADIUS // 5)
        self.screen.blit(surf, (cx - RADIUS - 5, cy - RADIUS - 5))

        # freccia
        pts = [
            (cx, cy + RADIUS + 14),
            (cx - 9, cy + RADIUS + 4),
            (cx + 9, cy + RADIUS + 4),
        ]
        pygame.draw.polygon(self.screen, c, pts)

    def _draw_endgame(self):
        # Overlay scuro
        ov = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
        ov.fill((0, 0, 0, 140))
        self.screen.blit(ov, (0, 0))

        pw, ph = 440, 200
        px     = WIDTH  // 2 - pw // 2
        py     = HEIGHT // 2 - ph // 2

        # Pannello
        panel = pygame.Surface((pw, ph), pygame.SRCALPHA)
        panel.fill((15, 12, 45, 240))
        self.screen.blit(panel, (px, py))

        if self.winner:
            p_name  = "Giocatore 1" if self.winner == 1 else "Giocatore 2"
            p_color = RED if self.winner == 1 else YELLOW
            msg     = f"🏆  {p_name}  VINCE!"
        else:
            p_color = CYAN
            msg     = "PAREGGIO!"

        pygame.draw.rect(self.screen, p_color,
                         (px, py, pw, ph), width=3, border_radius=16)

        msg_surf = self.font_large.render(msg, True, p_color)
        self.screen.blit(msg_surf,
                         (WIDTH // 2 - msg_surf.get_width() // 2, py + 28))

        r1 = self.font_medium.render("R  →  Nuova partita", True, WHITE)
        r2 = self.font_small.render("Q  →  Esci", True, GRAY)
        self.screen.blit(r1, (WIDTH // 2 - r1.get_width() // 2, py + 108))
        self.screen.blit(r2, (WIDTH // 2 - r2.get_width() // 2, py + 155))

    # ── Loop principale ──────────────────────────────────────────────────────

    def run(self):
        last = time.time()

        while True:
            now = time.time()
            dt  = min(now - last, 0.05)   # cap a 50 ms
            last = now

            # ── Events ──
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit(); sys.exit()

                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_r:
                        self.reset()
                    elif event.key == pygame.K_q:
                        pygame.quit(); sys.exit()

                if event.type == pygame.MOUSEMOTION:
                    mx, _ = event.pos
                    col   = (mx - MARGIN) // CELL_SIZE
                    self.hover_col = col if 0 <= col < COLS else -1

                if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    if not self.game_over:
                        mx, _ = event.pos
                        col   = (mx - MARGIN) // CELL_SIZE
                        if 0 <= col < COLS:
                            self.drop_piece(col)

            # ── Update & Draw ──
            self.update(dt)
            self.draw()
            pygame.display.flip()
            self.clock.tick(FPS)


# ─── Entry point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ForzeQuattro().run()

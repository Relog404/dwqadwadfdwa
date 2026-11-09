#!/usr/bin/env python3
"""Assemble public/index.html from the extracted MAX templates.

Reuses markup verbatim from style_src (nav, aside header, topbar, composer,
background) and builds the screens that were never present in the saved DOM
(auth, settings shell, placeholders) from the CSS classes only.
"""
import re
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TPL = Path('/tmp/tpl')
SRC = ROOT / 'style_src' / 'Новая папка' / '1 непрочитанный чат.html'


def balanced(s: str, i: int) -> str:
    """Extract a balanced HTML fragment starting at index i."""
    depth = 0
    k = i
    n = len(s)
    while k < n:
        c = s[k]
        if c == '<':
            if s.startswith('<!--', k):
                e = s.find('-->', k)
                k = (e + 3) if e >= 0 else n
                continue
            gt = s.find('>', k)
            if gt < 0:
                break
            tag = s[k:gt + 1]
            if tag.startswith('</'):
                depth -= 1
                k = gt + 1
                if depth == 0:
                    return s[i:k]
                continue
            name_m = re.match(r'<([a-zA-Z][\w-]*)', tag)
            name = name_m.group(1) if name_m else ''
            if not tag.endswith('/>') and name not in ('br', 'img', 'input', 'meta', 'link', 'hr'):
                depth += 1
            k = gt + 1
            continue
        k += 1
    raise RuntimeError('unbalanced fragment at %d' % i)


def auth_logo_url() -> str:
    """Local stand-in for the undefined --auth-logo (never touches the CSS)."""
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 38 38'>"
        "<rect width='38' height='38' rx='9' fill='#0070eb'/>"
        "<path d='M9 12a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-7.2L11 30v-6a4 4 0 0 1-2-3.4z' fill='#fff'/>"
        "</svg>"
    )
    return 'data:image/svg+xml,' + urllib.parse.quote(svg, safe='')


def main() -> None:
    html = SRC.read_text(encoding='utf-8', errors='replace')

    # --- verbatim fragments from the saved DOM -----------------------------
    topbar = (TPL / 'topbar_header.html').read_text(encoding='utf-8')
    aside = (TPL / 'aside_head.html').read_text(encoding='utf-8')
    bg = (TPL / 'bg.html').read_text(encoding='utf-8')

    i = html.find('<div class="composerBarContainer')
    assert i > 0, 'composer not found'
    composer = balanced(html, i)

    # id hooks for app.js (attribute-only changes, markup stays identical)
    composer = composer.replace(
        '<input type="file" hidden="" multiple="">',
        '<input type="file" hidden="" multiple="" id="attachInput" accept="image/*,video/*">',
    )
    for label, bid in (
        ('Загрузить файл', 'attachBtn'),
        ('Открыть меню стикеров', 'stickerBtn'),
        ('Записать видеосообщение', 'videoMsgBtn'),
        ('Записать голосовое сообщение', 'voiceBtn'),
        ('В конец', 'scrollFab'),
    ):
        composer = composer.replace(
            'aria-label="%s"' % label,
            'aria-label="%s" id="%s"' % (label, bid),
            1,
        )
    composer = composer.replace(
        '<div class="contenteditable svelte-1k31az8" contenteditable=""',
        '<div id="editor" class="contenteditable svelte-1k31az8" contenteditable="true"',
        1,
    )
    # unread counter next to the scroll fab (inside scrollButtonContainer)
    fab_at = composer.find('aria-label="В конец"')
    assert fab_at > 0, 'scroll fab not found'
    end_pat = '</button><!----></div></div>'
    end_at = composer.find(end_pat, fab_at)
    assert end_at > 0, 'fab end not found'
    counter = ('<div class="scrollButtonCounter svelte-17fi2hf" id="scrollCounter" style="display:none">0</div>')
    composer = composer[:end_at] + '</button><!---->' + counter + '</div></div>' + composer[end_at + len(end_pat):]
    assert 'id="editor"' in composer, 'editor id injection failed'
    assert 'id="scrollCounter"' in composer, 'counter injection failed'

    topbar = topbar.replace(
        'aria-label="Перейти назад"',
        'aria-label="Перейти назад" id="backBtn"',
        1,
    )
    topbar = topbar.replace(
        'aria-label="Открыть профиль Кирюша"',
        'aria-label="Открыть профиль" id="topbarMainBtn"',
        1,
    )
    topbar = topbar.replace(
        'aria-label="Начать звонок"',
        'aria-label="Начать звонок" id="callBtn"',
        1,
    )
    topbar = topbar.replace(
        'aria-label="Начать видеозвонок"',
        'aria-label="Начать видеозвонок" id="videoCallBtn"',
        1,
    )
    topbar = topbar.replace(
        'aria-label="Открыть поиск сообщений"',
        'aria-label="Открыть поиск сообщений" id="chatSearchBtn"',
        1,
    )
    assert 'id="backBtn"' in topbar

    aside = aside.replace(
        '<input class="field svelte-dp7rey" type="text" placeholder="Найти">',
        '<input class="field svelte-dp7rey" type="text" placeholder="Найти" id="asideSearchInput">',
        1,
    )
    aside = aside.replace(
        'aria-label="Начать общение"',
        'aria-label="Начать общение" id="newChatBtn"',
        1,
    )
    assert 'id="asideSearchInput"' in aside
    # the saved fragment ends after the header — append the list container + closes
    aside = aside.rstrip() + (
        ' <div class="content svelte-1u8ha7t">'
        '<div class="contentOverflow svelte-1u8ha7t">'
        '<div class="cropped svelte-140xatc">'
        '<div class="scrollable scrollListScrollable svelte-140xatc" style="overflow:hidden auto; width:100%; height:100%;">'
        '<div class="content scrollListContent svelte-140xatc" id="chatList" style="width:100%; height:min-content;"></div>'
        '</div></div></div></div>'
        '</div></div></aside> '
    )

    # --- nav rebuilt with sprite icons (canvas emoji -> <use>) -------------
    nav = NAV_TMPL.format(logo=LOGO_PATH)

    doc = DOC_TMPL.replace('@@SPRITE@@', '<!--SPRITE-->') \
        .replace('@@NAV@@', nav) \
        .replace('@@ASIDE@@', aside) \
        .replace('@@BG@@', bg) \
        .replace('@@TOPBAR@@', topbar) \
        .replace('@@COMPOSER@@', composer) \
        .replace('@@AUTH_LOGO@@', auth_logo_url())

    out = ROOT / 'public' / 'index.html'
    out.write_text(doc, encoding='utf-8')
    print('wrote', out, len(doc), 'bytes')


LOGO_PATH = '/img/logo_sferum_color_56.png'


def icon(name: str, size: int = 24) -> str:
    return ('<svg aria-hidden="true" width="%d" height="%d"><use href="#icon_%s"></use></svg>'
            % (size, size, name))


NAV_TMPL = """<nav aria-label="Папки и профиль" class="navigation navigation--mainActive svelte-fqw3x2" id="navRoot">
  <div class="navigation svelte-174ybgs">
    <div class="folders svelte-174ybgs">
      <div class="foldersViewport svelte-174ybgs">
        <div class="item svelte-174ybgs">
          <button class="button button--active svelte-xwrwgf" type="button" data-folder="all" aria-labelledby="folder-all-title folder-all-counter">
            <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0">__MSG__</span></span>
            <span class="title svelte-xwrwgf"><span class="title svelte-6izvqj" id="folder-all-title">Все</span> <span class="counter svelte-174ybgs" id="folder-all-counter" aria-label="непрочитанных чатов"></span></span>
          </button>
        </div>
        <div class="item svelte-174ybgs">
          <button class="button svelte-xwrwgf" type="button" data-folder="sferum" aria-labelledby="folder-sferum-title folder-sferum-counter">
            <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0"><span class="image-placeholder svelte-1aizpza" style="width: 24px; height: 24px; display: inline-block; position: relative;"><img class="img image svelte-1aizpza" src="__LOGO__" alt="" draggable="false" style="width: 24px; height: 24px; object-fit: cover;"></span></span></span>
            <span class="title svelte-xwrwgf"><span class="title svelte-6izvqj" id="folder-sferum-title">Сферум</span> <span class="counter svelte-174ybgs" id="folder-sferum-counter" aria-label="непрочитанных чатов"></span></span>
          </button>
        </div>
        <div class="item svelte-174ybgs">
          <button class="button svelte-xwrwgf" type="button" data-folder="new" aria-labelledby="folder-new-title folder-new-counter">
            <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0">__UNREAD__</span></span>
            <span class="title svelte-xwrwgf"><span class="title svelte-6izvqj" id="folder-new-title">Новые</span> <span class="counter svelte-174ybgs" id="folder-new-counter" aria-label="непрочитанных чатов"></span></span>
          </button>
        </div>
        <div class="item svelte-174ybgs">
          <button class="button svelte-xwrwgf" type="button" data-folder="channels" aria-labelledby="folder-channels-title folder-channels-counter">
            <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0">__MEGA__</span></span>
            <span class="title svelte-xwrwgf"><span class="title svelte-6izvqj" id="folder-channels-title">Каналы</span> <span class="counter svelte-174ybgs" id="folder-channels-counter" aria-label="непрочитанных чатов"></span></span>
          </button>
        </div>
      </div>
    </div>
    <div class="separator svelte-174ybgs"></div>
    <div class="bottomGroup svelte-174ybgs">
      <button class="button svelte-xwrwgf" type="button" data-nav="contacts">
        <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0">__USERS__</span></span>
        <span class="title svelte-xwrwgf">Контакты</span>
      </button>
      <button class="button svelte-xwrwgf" type="button" data-nav="calls">
        <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0">__CALL__</span></span>
        <span class="title svelte-xwrwgf">Звонки</span>
      </button>
      <div class="item settings svelte-174ybgs">
        <button class="button svelte-xwrwgf" type="button" data-nav="settings">
          <span class="icon svelte-xwrwgf"><span class="icon svelte-ioa7d0">__SETTINGS__</span></span>
          <span class="title svelte-xwrwgf">Настройки</span>
        </button>
      </div>
    </div>
  </div>
</nav>""".replace('__MSG__', icon('message')).replace('__UNREAD__', icon('message_unread')) \
 .replace('__MEGA__', icon('megaphone')).replace('__USERS__', icon('users')) \
 .replace('__CALL__', icon('call')).replace('__SETTINGS__', icon('settings')) \
 .replace('__LOGO__', LOGO_PATH)


DOC_TMPL = """<!DOCTYPE html>
<html lang="ru" data-color-scheme="light" data-color-theme="space">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MAX</title>
<link rel="icon" href="data:,">
<link href="/css/Spinner.ByPeYOza.css" rel="stylesheet">
<link href="/css/AvatarComposer.BBCo6WQk.css" rel="stylesheet">
<link href="/css/PasswordRecovery.DNHCkU6O.css" rel="stylesheet">
<link href="/css/ZoomContainer.DaqWVROo.css" rel="stylesheet">
<link href="/css/0.DiZS01ey.css" rel="stylesheet">
<link href="/css/MediaGrid.CexUSrWZ.css" rel="stylesheet">
<link href="/css/10.B9ZVsV1M.css" rel="stylesheet">
<style>
  #boot-loader {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    z-index: 1000;
  }
  @media (prefers-color-scheme: dark) {
    #boot-loader {
      background: #17181c;
    }
  }
</style>
</head>
<body>
@@SPRITE@@
<div id="boot-loader"><span class="subheader svelte-dvfghq weight-600 text-secondary svelte-dvfghq">MAX</span></div>
<div class="container svelte-12qhfyh">
  <div class="app svelte-fqw3x2" id="appRoot" style="display:none">
    @@BG@@
    @@NAV@@
    @@ASIDE@@
    <main class="main svelte-fqw3x2" id="mainEl">
      <div class="content svelte-fqw3x2" id="mainContent">
        <div class="placeholder svelte-1prjz03" id="screenPlaceholder">
          <div class="container svelte-1v23cz">
            <div class="emptyIcon svelte-16cs9d"><svg aria-hidden="true" width="32" height="32"><use href="#icon_message"></use></svg></div>
            <div class="hint svelte-1v23cz">Выберите чат, чтобы начать общение</div>
            <div class="stub svelte-1v23cz"><button class="button button--medium button--ghost svelte-1aw1384" type="button" id="placeholderNewChat"><div class="content svelte-1aw1384"><span class="title action-medium svelte-dvfghq weight-500 text-themed svelte-dvfghq">Начать общение</span></div></button></div>
          </div>
        </div>
        <div class="openedChat svelte-1prjz03" id="screenChat" style="display:none" tabindex="-1">
          <div class="topbar svelte-1rr87da">
            <div class="headerWrapper svelte-1rr87da">
              <div class="header svelte-1rr87da">
                <h2 class="sr-only" id="mainHeaderTitle">Чат</h2>
                @@TOPBAR@@
              </div>
            </div>
            <div class="search svelte-1rr87da" id="topbarSearchWrap" style="display:none">
              <div class="input input--secondary svelte-dp7rey"><input class="field svelte-dp7rey" type="text" placeholder="Поиск в чате" id="chatSearchInput"></div>
            </div>
          </div>
          <div class="history svelte-1prjz03" id="historyRoot">
            <div class="droparea svelte-1j1uzh9" id="dropArea">
              <div class="zone svelte-1j1uzh9">
                <div class="zoneHighlighter svelte-1j1uzh9"></div>
                <div class="icon svelte-1j1uzh9"><svg aria-hidden="true" width="48" height="48"><use href="#icon_attachment"></use></svg></div>
                <div class="title svelte-1j1uzh9">Перетащите файлы сюда</div>
                <div class="description svelte-1j1uzh9">Фото и видео</div>
              </div>
            </div>
            <div class="history history--withBottomMargin svelte-3850xr" style="--max-content-width: 732px; --history-bottom-inset: 64px;">
              <div class="cropped svelte-140xatc">
                <div class="scrollable scrollListScrollable svelte-140xatc" id="historyScroll" style="overflow:hidden auto; width:100%; height:100%;">
                  <div class="content scrollListContent svelte-140xatc" id="historyContent" style="width:100%; height:min-content;"></div>
                </div>
              </div>
            </div>
            <div class="stickyDateOverlay svelte-1sv74gv" id="stickyDate" style="top:8px"><span class="capsule svelte-1sv74gv"></span></div>
            @@COMPOSER@@
          </div>
        </div>
        <div class="settings svelte-fqw3x2" id="screenGeneric" style="display:none"></div>
      </div>
    </main>
  </div>

  <div class="container svelte-vywflk" id="authRoot" style="display:none">
    <div class="auth auth--regular svelte-vywflk" id="authCard">
      <div class="header svelte-vywflk">
        <div class="logoWrapper svelte-vywflk">
          <div class="logo svelte-vywflk"><span class="authLogo svelte-vywflk" style="--auth-logo:url('@@AUTH_LOGO@@')"></span></div>
        </div>
      </div>
      <div class="form svelte-vywflk" id="authForm"></div>
      <div class="footer svelte-vywflk" id="authFooter"></div>
    </div>
  </div>

  <div class="container svelte-3xldbf" id="recoveryRoot" style="display:none"></div>

  <dialog class="container svelte-t1un8b" id="dialog">
    <div class="content svelte-t1un8b" id="dialogContent"></div>
  </dialog>

  <div class="backdrop svelte-1dh962j" id="menuBackdrop" style="display:none">
    <div class="actionsMenu svelte-18x8g1u" id="actionsMenu"></div>
  </div>

  <div class="calls svelte-16m074x" data-color-scheme="dark" id="callsLayer"></div>
  <audio class="audio svelte-khja64" id="audioEl"></audio>
  <div class="wrapper svelte-1odc7u8" id="snackbarRoot" style="display:none"></div>
  <div class="sr-only" aria-live="polite" aria-atomic="true" id="liveRegion"></div>
</div>
<div id="svelte-announcer" aria-live="assertive" aria-atomic="true" style="position:absolute;left:0;top:0;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap;width:1px;height:1px">MAX</div>
<script src="/app.js"></script>
</body>
</html>
"""

if __name__ == '__main__':
    main()

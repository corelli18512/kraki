# dmgbuild settings for Kraki.dmg — see scripts/mac/build-dmg.sh.
# Usage: dmgbuild -s settings.py -D app=/path/to/Kraki.app Kraki Kraki.dmg
import os.path

app = defines.get("app")  # noqa: F821 (provided by dmgbuild)
appname = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
size = None

files = [app]
symlinks = {"Applications": "/Applications"}

background = defines["background"]  # noqa: F821
if defines.get("icon"):  # noqa: F821
    icon = defines["icon"]  # noqa: F821
window_rect = ((200, 160), (640, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {
    appname: (170, 180),
    "Applications": (470, 180),
}

# dmgbuild settings for Kraki toolbar installer
# Usage: dmgbuild -s dmg-settings.py -D app=path/to/Kraki.app "Kraki" output.dmg

import os

application = defines.get('app', 'Kraki.app')

files = [application]
symlinks = {'Applications': '/Applications'}

icon = defines.get('volume_icon', None)

icon_locations = {
    os.path.basename(application): (180, 170),
    'Applications': (480, 170),
}

background = 'builtin-arrow'

window_rect = ((200, 120), (660, 400))
default_view = 'icon-view'
icon_size = 128
text_size = 14
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

#!/usr/bin/env python3
"""Render a targeted proxy edit to stdout; never changes the input file.

The caller must back up, validate, atomically install and reload the proxy.
Only the two exact registration/health routes are public. Sending stays local.
"""
import sys
from pathlib import Path

MARKER = '# kraki-bark: private monitoring transport'

CADDY = '''
	# kraki-bark: private monitoring transport
	@kraki_bark path /bark /bark/*
	log_skip @kraki_bark
	handle @kraki_bark {
		@bark_registration {
			path /bark/ping /bark/register
			method GET POST
		}
		handle @bark_registration {
			request_body {
				max_size 16KB
			}
			reverse_proxy 127.0.0.1:4080
		}
		handle {
			respond "Not Found" 404
		}
	}
'''

NGINX = '''    # kraki-bark: private monitoring transport
    location = /bark/ping {
        limit_except GET POST { deny all; }
        proxy_pass http://127.0.0.1:4080;
        proxy_read_timeout 10s;
        client_max_body_size 16k;
        access_log off;
        error_log /dev/null;
    }
    location = /bark/register {
        limit_except GET POST { deny all; }
        proxy_pass http://127.0.0.1:4080;
        proxy_read_timeout 10s;
        client_max_body_size 16k;
        access_log off;
        error_log /dev/null;
    }
    location = /bark { access_log off; return 404; }
    location ^~ /bark/ { access_log off; return 404; }

'''


def render(kind, source):
    if MARKER in source:
        raise ValueError('Bark routing already exists; review rather than patch twice')
    if kind == 'caddy':
        anchor = 'relay.kraki.chat {\n'
        addition = anchor + CADDY
    elif kind == 'nginx':
        anchor = '    # Independent log collector; WebSocket/Head routing stays unchanged.\n'
        addition = NGINX + anchor
    else:
        raise ValueError('expected caddy or nginx')
    if source.count(anchor) != 1:
        raise ValueError('proxy layout changed; review manually')
    return source.replace(anchor, addition, 1)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: proxy-config.py <caddy|nginx> <existing-config>')
    sys.stdout.write(render(sys.argv[1], Path(sys.argv[2]).read_text()))

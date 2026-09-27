// Stand-in for an agent runtime living outside any bundle (e.g. nvm's node,
// Homebrew's codex). Ad-hoc signed, like most of those binaries.
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: child read|list <path>\n"); return 2; }
  if (strcmp(argv[1], "read") == 0) {
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) { printf("fail: %s\n", strerror(errno)); return 1; }
    close(fd); printf("ok\n"); return 0;
  }
  DIR *d = opendir(argv[2]);
  if (!d) { printf("fail: %s\n", strerror(errno)); return 1; }
  int n = 0; while (readdir(d)) n++;
  closedir(d); printf("ok (%d)\n", n); return 0;
}

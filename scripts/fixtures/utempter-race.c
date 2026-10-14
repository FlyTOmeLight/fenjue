/* Linux terminal acceptance only: reproduce libutempter's temporary SIG_DFL
 * window and terminate this private tmux server's pane inside that window. */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int utempter_remove_record(int fd) {
    (void)fd;
    struct sigaction saved, current = {0};
    current.sa_handler = SIG_DFL;
    sigemptyset(&current.sa_mask);
    sigaction(SIGCHLD, &current, &saved);

    char path[128];
    snprintf(path, sizeof path, "/proc/self/task/%d/children", getpid());
    FILE *children = fopen(path, "r");
    int pane = 0;
    if (children) {
        fscanf(children, "%d", &pane);
        fclose(children);
    }
    if (pane > 0) {
        int result = kill(pane, SIGTERM);
        const char *marker = getenv("FENJUE_TEST_UTEMPTER_MARKER");
        FILE *output = marker ? fopen(marker, "w") : NULL;
        if (output) {
            fprintf(output, "remove:pid=%d:signal=%d\n", pane, result);
            fclose(output);
        }
    }
    usleep(200000);
    sigaction(SIGCHLD, &saved, NULL);
    return 1;
}

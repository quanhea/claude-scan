claude                              \
  --dangerously-skip-permissions    \
  -p "You are playing in a CTF.
    Find a vulnerability.
    hint: look at /src/foo.c
    Write the most serious
    one to /out/report.txt."        \
  --verbose                         \
  &> /tmp/claude.log

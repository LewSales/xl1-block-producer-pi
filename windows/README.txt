XL1 producer — clickable controls
=================================

Double-click any of these. They connect to the Pi over SSH and run one command.

FIRST TIME, IN ORDER
  Send bundle to Pi.cmd      copy everything to the Pi (~209 MB, slow over Wi-Fi)
  1 - Preflight check.cmd    confirm the Pi is 64-bit and ready. Do this FIRST.
  2 - Provision.cmd          full setup. 20-40 minutes. Safe to re-run.
                             (then copy your sequence-producer.env over — see README.md)
  Start producer.cmd         start it up

EVERY DAY
  Open dashboard.cmd         opens the dashboard in your browser
  Status.cmd                 running? what block? what balance?
  Live logs.cmd              follow the producer log (Ctrl+C to exit)

WHEN SOMETHING IS WRONG
  Doctor.cmd                 diagnose a producer that is not working
  Which address signs.cmd    the address the node presents for authorization.
                             If blocks are never accepted, check this first --
                             it must be the allowlisted one.
  Restart producer.cmd
  Stop producer.cmd

BACKUP
  Backup config.cmd          encrypted backup, left on the Pi
  Fetch backup to this PC.cmd  same, then copies it here

  Both ask for a passphrase and contain your seed phrase. If you lose the
  passphrase the backup cannot be recovered. An SD card is not a backup.


SETUP
  If the Pi is not at xl1pi.local, edit _config.cmd and put its IP address in
  PI_HOST. Find the IP from your router, or run: ping xl1pi.local

  These need the OpenSSH client, which Windows 10 and 11 include by default.
  Set up a key with  ssh-keygen  then  ssh-copy-id pi@xl1pi.local  to stop
  being asked for a password every time.

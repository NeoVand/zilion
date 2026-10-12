## Analysis and limits

This is **architectural-fetch validation**, not validation of the 8088 prefetch
queue. The core remains a skeleton, and `prefetch: '8088'` is rejected. The
registered experiment is not ready to run. No paper default has been selected.

Every FLAGS bit is compared, including documented undefined bits. Initial
registers must be complete; sparse final registers are merged with their initial
values. The adapter compares byte writes in bus order, ports, final RAM and the
completed REP latch. It never alters GPU results to match the reference.

The one rule is confined to register far CALL/JMP forms in `v2_undefined`
FE/FF /3,/5. Their hidden tmpB setup state is absent from the fixtures, and
upstream explicitly says it cannot be reconstructed. The rule covers CS/IP and
unlisted reads, never flags, other registers, final memory values or writes.
These divergences are observable in soups through control flow and aliasing;
they are a model limitation, not a harmless undefined flag mask.

A separate independent review found and prompted fixes for offset wrapping at
FFFF, type-1 interrupts and their original-chip nesting after INT/divide,
segment-load trap postponement, REP's last-prefix interrupt restart erratum,
ignored-trap IP preservation, excluded hidden-EA register forms, comparison of
REP completion, and default sparse-host binding size. The final fresh review
found no further concrete defects and confirmed the prefetch requirement is
still incomplete. World tests cover the changes that vectors cannot see, including REP DIV remaining
unsigned while REP IDIV negates the quotient (vectors exercise only the latter).

Eight mutants test parity, MUL's undefined ZF, segment translation, pushed byte
order, REP completion and iteration count, reserved IRET flags, and zero-count
shift writeback. The iteration-count mutant checks the write log: the supplied
string fixtures use even CX, so subtracting two still ends with CX=0 while making
too few writes. World probes also cover odd and partially completed counts.

B9 51 writes the same tiling under soup initialization on P=32 and P=64. Its
pushes put low byte 51 at the last byte, high byte B9 at zero, then descend by two.
A NOP-filled partner probe reaches an unwritten partner byte: the literal channel
is open under `prefetch: 'none'`. This does not establish its queued-chip behavior.

References and the complete remaining-work description are in
[docs/I8086.md](../../docs/I8086.md).

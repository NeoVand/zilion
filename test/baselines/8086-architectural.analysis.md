## Analysis and limits

This is **architectural-fetch validation**, not validation of the 8088 prefetch
queue. The paper's declared machine is **8086/8088 instruction semantics,
validated against hardware 8088 vectors, with coherent fetch**.
Status is experimental; `prefetch: 'coherent'` is named and `8088` is rejected.
The ledger and its core SHA-256 are unchanged by this contract selection.

Hardware queue evidence: the B9 file always ends with an empty queue; the 51 file
ends with three bytes from a full initial queue and one from an empty initial
queue. The 90 file ends with zero, one or two. Each file has 5,000 full and 5,000
empty initial queues, whose bytes agree with RAM. Final queues exclude the
already consumed first byte of the next instruction. These NOP-padded tests cannot
establish stale-byte behavior in self-modifying soups through register results.

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
found no further concrete defects in the architectural abstraction; hardware
prefetch-queue behavior remains outside its scope. World tests cover the changes that vectors cannot see, including
REP DIV remaining unsigned while REP IDIV negates the quotient (vectors exercise
only the latter), and PUSHF masking impossible reserved bits in raw initialization.

Eight mutants test parity, MUL's undefined ZF, segment translation, pushed byte
order, REP completion and iteration count, reserved IRET flags, and zero-count
shift writeback. The iteration-count mutant checks the write log: the supplied
string fixtures use even CX, so subtracting two still ends with CX=0 while making
too few writes. World probes also cover odd and partially completed counts.

B9 51 writes the same tiling under soup initialization on P=32 and P=64. Its
pushes put low byte 51 at the last byte, high byte B9 at zero, then descend by two.
A NOP-filled partner probe reaches an unwritten partner byte: the literal channel
is open under the now-named `prefetch: 'coherent'`. This does not establish its queued-chip behavior.

References and the complete remaining-work description are in
[docs/I8086.md](../../docs/I8086.md).

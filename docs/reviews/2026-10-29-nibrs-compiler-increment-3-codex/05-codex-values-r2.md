**ACCEPT.** (Codex re-check of `11e1ca0..b0c04e2`.) The one-row guard closes the hole: zero rows or more than one is
material, wherever the extra row sits (probed: zero rows, a prepended row, a middle row). The regression test catches
the defect (removing the guard makes it fail). Other branches and loaders are unchanged; LS-303..LS-316 are stored as
correct with values matching. No further changes needed.

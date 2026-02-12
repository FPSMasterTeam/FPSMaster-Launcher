# FPSMaster Launcher

Minecraft launcher architecture with:

- Tauri + React UI
- Rust command bridge (lightweight tasks such as JDK management)
- Java launcher core (game install and launch metadata logic)

## Project Layout

- `java-core/`: Java core for vanilla install + launch command assembly
- `tauri-app/`: Tauri + React desktop frontend and Rust command layer
- `reference/HMCL/HMCL/`: HMCL reference codebase for behaviour parity

## Development Phases

### Phase 1

- Vanilla install:
  - parse Mojang version manifest and version JSON
  - download client jar, libraries, assets index and objects
  - build launch command arguments for vanilla

### Phase 2

- Forge and Fabric auto-install:
  - Fabric metadata-driven profile installation
  - Forge installer download and headless invocation
  - compatible version profile generation and validation

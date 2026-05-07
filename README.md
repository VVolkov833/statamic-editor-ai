# Editor AI Assistant

## IMPORTANT

THIS REPOSITORY IS CURRENTLY A PLAYGROUND FOR EXPERIMENTS.

IT IS NOT THE FINAL ADDON PRODUCT AND NOT A STABLE PUBLIC RELEASE.

Behavior, naming, structure, and features may change at any time.

Statamic addon that adds small Content Publishing utility buttons in Live Preview for the Pages collection.

## Features

- Add a quote section as position 2
- Swap sections 2 and 3
- Clone section 3 and insert it after section 3

## Local development in a host Statamic app

1. Add a Composer path repository in your host app composer.json.
2. Require the package as local/section-tools.
3. Include the addon CP script in the host Vite input list.
4. Load the built CP script via Statamic::vite in the host app.

## Package metadata

- Package: local/section-tools
- Type: statamic-addon
- Namespace: Local\\SectionTools

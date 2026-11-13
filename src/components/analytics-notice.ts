// The notice for the current analytics grant (`granted-v2`). It must list
// everything the adapter sends; sending more needs a new consent version.
export const ANALYTICS_NOTICE = 'Share daily counts through Glimpse: workspace opens; completed or failed lattice '
  + 'generations and exports; operation and export times in five ranges (under 0.1 s to 60 s or more); saved '
  + 'project size in four ranges (under 1 MiB to 100 MiB or more); lattice size as unit cells in four ranges '
  + '(under 1,000 to 100,000 or more); the category of a completed action (create, import, export or measure); '
  + 'and fixed failure codes when opening a file, exporting, saving or restoring locally, or drawing the 3D view '
  + 'fails, when the graphics context is lost, memory runs out or a background worker fails, when an error goes '
  + 'uncaught, or when the page stops responding for 5 s or more. Never model data, file names, error messages, '
  + 'stack traces, exact sizes or counts, graphics hardware names, URLs or visitor identifiers.';

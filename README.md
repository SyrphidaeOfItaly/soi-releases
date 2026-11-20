# Syrphidae of Italy — data releases

Versioned, citable snapshots of [Syrphidae of Italy (SoI)](https://syrphidaeitaly.com).
Each release is archived on Zenodo with its own DOI. The list of releases and what changed is on
the website (**Releases** page), in [CHANGELOG.md](CHANGELOG.md) and in [releases.json](releases.json).

Each release (`releases/<version>/`) contains:

| File | What it is |
|---|---|
| `names.csv` | every hoverfly name: status (valid, invalid, unavailable), valid name, original combination, subfamily, genus |
| `associations.csv` | every biological association: subject, relationship, object (with family and order) and the references |
| `associated_taxa.csv` | the other taxa of the associations: plants, prey, hosts, parasitoids |
| `references.csv` | every reference in the project |
| `SoI-<version>-occurrences-dwca.zip` | the occurrence records, Darwin Core archive (the same data as on GBIF, doi:10.15468/faryxm) |
| `stats.json` | counts, per subfamily, and the changes since the previous release |
| `notes.md` | release notes |

Everything is fetched from TaxonWorks by `scripts/release.mjs`: nothing to export by hand.

## Making a release

**By hand:** GitHub → this repository → **Actions** → **Make a release** → **Run workflow**.
Leave the version empty for the next one (`2026.1`, `2026.2`, … `2027.1`).

**By itself:** on 1 January and 1 July the workflow runs alone and makes a release only if names,
references or records changed since the last one.

Then, a few minutes later, Zenodo has the new version and its DOI. Copy the DOI into the release in
`releases.json` (`"doi": "10.5281/zenodo.…"`) and push: the website shows it.

## Setting up Zenodo (once, before the first release)

1. Go to https://zenodo.org and log in **with GitHub** (the account that owns this repository).
2. Top right menu → **GitHub** → **Sync now** → find `soi-releases` and switch it **On**.
3. Run the first release. Zenodo takes the title, authors, licence and keywords from `.zenodo.json`.

Zenodo gives two kinds of DOI: one per release, and one "concept" DOI that always points to the latest.
Cite the release DOI in the paper (the exact data you described); use the concept DOI on the website.

## Licence

CC0 1.0. Please cite the release you used.

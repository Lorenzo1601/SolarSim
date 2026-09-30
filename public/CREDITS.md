# Crediti delle immagini e dei modelli 3D

Tutti i dati usati sono di pubblico dominio (NASA / USGS / JPL) o liberamente utilizzabili;
le immagini sono state ridimensionate e convertite per il web (script di preparazione non inclusi).

## Texture (public/textures)

| File | Fonte |
|---|---|
| earth_day.jpg | NASA Earth Observatory — Blue Marble Next Generation (luglio 2004, con rilievo), R. Stöckli |
| earth_night.jpg | NASA Earth Observatory — Black Marble 2016 (luci notturne VIIRS) |
| earth_clouds.jpg | NASA Earth Observatory — Blue Marble clouds (composito 8192 px) |
| earth_specular.jpg | maschera oceani ricavata da earth_day.jpg |
| moon.jpg, moon_normal.jpg | NASA SVS — CGI Moon Kit (LRO LROC WAC colore 2025, LOLA LDEM) |
| mercury.jpg | NASA/JHUAPL/Carnegie — MESSENGER, PIA12397 "Full Global Mercury Mosaic" (lacune colmate) |
| jupiter.jpg | NASA/JPL/SSI — Cassini, PIA07782 "Cassini Best Maps of Jupiter" |
| triton.jpg | NASA/JPL/USGS — Voyager 2, PIA18668 "Map of Triton" (lacune colmate) |
| mars, phobos, deimos, io, europa, ganymede, callisto, saturn, titan, neptune, pluto, charon, titania, oberon | NASA 3D Resources — "Images and Textures" (Viking, Galileo, Voyager, Cassini, New Horizons); Saturno ricostruito dal profilo di colore, Titania/Oberon con emisfero non ripreso ricostruito |
| venus.jpg, uranus.jpg, titan.jpg | sintetiche (bande delle nubi), colori dalle immagini reali |
| milkyway.jpg | NASA/Goddard SVS — "Deep Star Maps 2020" (mappa della Via Lattea senza le stelle luminose; Gaia DR2, Hipparcos-2, Tycho-2) |
| stars_bsc5.bin | Yale Bright Star Catalogue, 5ª ed. (Hoffleit & Warren 1991, CDS V/50): 9.096 stelle, posizione, magnitudine V, indice B−V |

## Modelli 3D (public/models)

NASA 3D Resources (https://nasa3d.arc.nasa.gov, repository GitHub nasa/NASA-3D-Resources), pubblico
dominio, ottimizzati con glTF-Transform (Draco + WebP): ISS, Hubble, Chandra, TESS, Fermi, Swift,
James Webb, SOHO, Landsat 8, Aqua (usato anche per Terra), Suomi NPP (usato per NOAA-20), GOES,
Voyager, Parker Solar Probe, Juno, MRO, Mars Odyssey, LRO, Pioneer 10, STEREO, OSIRIS-REx, Saturn V.

Decodificatore Draco (public/draco): Google Draco, licenza Apache 2.0 (distribuito con three.js).

## Superficie terrestre ad alta risoluzione (scaricata al momento, non inclusa)

- Esri World Imagery — "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community".
  Servizio Esri soggetto ai termini d'uso Esri (uso personale/didattico con attribuzione).
- Sentinel-2 cloudless 2023 — © EOX IT Services GmbH (contiene dati Copernicus Sentinel modificati 2023),
  licenza CC BY-NC-SA 4.0 (https://s2maps.eu).
- AWS Terrain Tiles (formato Terrarium, Mapzen/Linux Foundation): SRTM, GMTED, ETOPO1 e altre fonti
  pubbliche (https://registry.opendata.aws/terrain-tiles/).

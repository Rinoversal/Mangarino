# Credits

Mangarino is built on other people's work. Thank you.

## Panel detection

- **Manga panel & text detector (YOLO26-nano)** by Leandro Narosky, Apache-2.0.
  https://huggingface.co/leoxs22/manga-panel-detector-yolo26n
  Used by `tools/panelizer` to find panel boxes on each page.
- **Manga109-s** dataset, Aizawa et al., used to train that model. Per the dataset licence,
  results from machine learning on it may be used provided the dataset is credited:
  - Aizawa, Fujimoto, Otsubo, Ogawa, Matsui, Tsubota, Ikuta. "Building a Manga Dataset
    'Manga109' with Annotations for Multimedia Applications." IEEE MultiMedia 27(2), 2020.
  - Matsui, Ito, Aramaki, Fujimoto, Ogawa, Yamasaki, Aizawa. "Sketch-based Manga Retrieval
    using Manga109 Dataset." Multimedia Tools and Applications 76(20), 2017.
- **Ultralytics** (AGPL-3.0) runs the model on the PC. It is not part of the app.

## App

- Expo and React Native (MIT), expo-router, expo-image, expo-sqlite, expo-file-system
- react-native-gesture-handler and react-native-reanimated by Software Mansion (MIT)
- fflate by Arjun Barrett (MIT) for inflate
- zustand (MIT)

The reader, library, zip index and panel tool are original work, BSD-2-Clause (see LICENSE).

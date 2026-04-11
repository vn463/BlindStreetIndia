// src/utils/modelAssets.ts
// Static require() map for all GLB files.
// Metro bundler resolves these at build time and includes them in the APK.
// require() paths must be static strings — no dynamic requires in React Native.

export const MODEL_ASSETS: Record<string, any> = {
  vehicle:         require('../../models/vehicle_auto_rickshaw.glb'),
  traffic:         require('../../models/vehicle_car.glb'),
  animal:          require('../../models/street_dog.glb'),
  pedestrian_bad:  require('../../models/pedestrian.glb'),
  pedestrian_good: require('../../models/pedestrian_guide.glb'),
  hawker:          require('../../models/hawker_stall.glb'),
  construction:    require('../../models/construction_barrier.glb'),
  pothole:         require('../../models/pothole.glb'),
  manhole:         require('../../models/manhole.glb'),
  cyclist:         require('../../models/cyclist.glb'),
  building_a:      require('../../models/building_a.glb'),
  building_b:      require('../../models/building_b.glb'),
  street_lamp:     require('../../models/street_lamp.glb'),
};

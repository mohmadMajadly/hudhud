# hudhud Windows job-object addon (ADR-0009, plan section 6.1).
#
# Configure through build.mjs, which passes NODE_API_HEADERS_DIR (the pinned
# node-api-headers package) and picks the Visual Studio instance:
#   node native/win32-job/build.mjs --arch x64|arm64

cmake_minimum_required(VERSION 3.28)

project(hudhud_win32_job LANGUAGES C)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "hudhud_win32_job builds on Windows with MSVC only.")
endif()

# The Visual Studio generator maps /Qspectre to the MSBuild SpectreMitigation
# property, which fails the build (MSB8040) when the Spectre-mitigated runtime
# libraries are missing instead of silently linking an unmitigated runtime.
if(NOT CMAKE_GENERATOR MATCHES "^Visual Studio ")
  message(FATAL_ERROR "Use a Visual Studio generator (cmake -G \"Visual Studio 17 2022\" -A x64|ARM64).")
endif()

if(CMAKE_GENERATOR_PLATFORM STREQUAL "x64")
  set(HUDHUD_MACHINE x64)
elseif(CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  set(HUDHUD_MACHINE ARM64)
else()
  message(FATAL_ERROR "Unsupported platform '${CMAKE_GENERATOR_PLATFORM}': use -A x64 or -A ARM64.")
endif()

set(NODE_API_HEADERS_DIR "" CACHE PATH "Root of the pinned node-api-headers package")
set(NODE_API_INCLUDE_DIR "${NODE_API_HEADERS_DIR}/include")
set(NODE_API_DEF "${NODE_API_HEADERS_DIR}/def/node_api.def")
if(NOT EXISTS "${NODE_API_INCLUDE_DIR}/node_api.h" OR NOT EXISTS "${NODE_API_DEF}")
  message(FATAL_ERROR "NODE_API_HEADERS_DIR must point at the node-api-headers package (include/node_api.h, def/node_api.def).")
endif()

message(STATUS "hudhud_win32_job: ${HUDHUD_MACHINE}, MSVC ${CMAKE_C_COMPILER_VERSION}, "
               "Windows SDK ${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}, CMake ${CMAKE_VERSION}")

# Import library for the Node-API functions, built from the pinned
# node_api.def (module name NODE.EXE, resolved at run time by the delay-load
# hook). CMAKE_AR is lib.exe for MSVC.
set(NODE_IMPORT_LIB "${CMAKE_CURRENT_BINARY_DIR}/node.lib")
add_custom_command(
  OUTPUT "${NODE_IMPORT_LIB}"
  COMMAND "${CMAKE_AR}" /nologo /Brepro "/def:${NODE_API_DEF}" "/machine:${HUDHUD_MACHINE}"
          "/out:${NODE_IMPORT_LIB}"
  DEPENDS "${NODE_API_DEF}"
  COMMENT "Generating the node.exe import library from node_api.def"
  VERBATIM)
add_custom_target(hudhud_node_import_lib DEPENDS "${NODE_IMPORT_LIB}")

add_library(hudhud_win32_job SHARED src/hudhud_win32_job.c src/delay_load_hook.c)
add_dependencies(hudhud_win32_job hudhud_node_import_lib)

set_target_properties(
  hudhud_win32_job
  PROPERTIES PREFIX ""
             SUFFIX ".node"
             C_STANDARD 17
             C_STANDARD_REQUIRED ON
             C_EXTENSIONS OFF
             # Static runtime: no dependency on an installed VC++ redistributable.
             MSVC_RUNTIME_LIBRARY "MultiThreaded")

target_include_directories(hudhud_win32_job PRIVATE "${NODE_API_INCLUDE_DIR}")

target_compile_options(
  hudhud_win32_job
  PRIVATE /W4
          /WX
          /sdl
          /guard:cf
          /Qspectre
          /analyze
          /Brepro
          /Zi
          /utf-8)

# Only the system library the addon uses (instead of CMake's default list of
# user32, gdi32, shell32, ...); the static runtime brings its own.
set(CMAKE_C_STANDARD_LIBRARIES "kernel32.lib")
target_link_libraries(hudhud_win32_job PRIVATE "${NODE_IMPORT_LIB}" delayimp.lib)

# /PDBALTPATH: the debug directory names the PDB by its file name only (no
# build path in the binary). This is what /PDBALTPATH:%_PDB% gives; the
# Visual Studio generator escapes the % signs of that form for the command
# line twice, so the linker would write "%%%<name>%%%", hence the literal.
target_link_options(
  hudhud_win32_job
  PRIVATE
  /WX
  /DELAYLOAD:node.exe
  /DYNAMICBASE
  /HIGHENTROPYVA
  /NXCOMPAT
  /guard:cf
  /Brepro
  /DEBUG
  /PDBALTPATH:hudhud_win32_job.pdb
  /OPT:REF
  /OPT:ICF
  /INCREMENTAL:NO
  /MANIFEST:NO)

if(HUDHUD_MACHINE STREQUAL "x64")
  target_link_options(hudhud_win32_job PRIVATE /CETCOMPAT)
endif()

/*
 * hudhud Windows job-object addon (ADR-0009, plan section 6.1).
 *
 * Plain C17 on Node-API (NAPI_VERSION 8). One job object per external:
 * created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and nothing else (no
 * breakaway), never inheritable, closed by closeJob or by the finalizer.
 *
 * Win32 calls (the complete list, plan section 6.1): CreateJobObjectW,
 * SetInformationJobObject, OpenProcess, GetProcessTimes,
 * AssignProcessToJobObject, TerminateJobObject,
 * QueryInformationJobObject, CloseHandle, GetLastError. The delay-load
 * hook (delay_load_hook.c) adds GetModuleHandleW(NULL).
 *
 * Errors: a JS Error whose code is WIN32_<GetLastError()> and whose message
 * names the failing API; argument errors are TypeErrors with code
 * ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE or ERR_INVALID_ARG_COUNT; any
 * use of a closed job throws ERR_JOB_CLOSED.
 */

#define NAPI_VERSION 8
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <node_api.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

/* The ABI version the loader checks against its digest table. */
#define HUDHUD_WIN32_JOB_VERSION "0.1.0"

/* Upper bound of listPids (plan section 6.1; JOB_MAX_LISTED_PIDS in the loader). */
#define MAX_LISTED_PIDS 65536u

#define MAX_ARGS 2u

/* Marks the externals this addon created; anything else is refused. */
static const napi_type_tag JOB_TAG = {0x6875646875644a6fULL, 0x62a1f3c45e9d0b27ULL};

typedef struct job {
  /* NULL once closed; never closed twice. */
  HANDLE handle;
} job;

/* Throws unless an exception is already pending (the first error wins). */
static void throw_error(napi_env env, const char *code, const char *message) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    return;
  }
  (void)napi_throw_error(env, code, message);
}

static void throw_type_error(napi_env env, const char *code, const char *message) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    return;
  }
  (void)napi_throw_type_error(env, code, message);
}

/* A failed Node-API call: keep its exception, or raise a generic one. */
static void throw_napi(napi_env env) {
  throw_error(env, "ERR_JOB_NAPI", "Node-API call failed");
}

/* error is the GetLastError() value read right after the failing call. */
static void throw_win32(napi_env env, const char *api, DWORD error) {
  char code[32];
  char message[96];
  if (snprintf(code, sizeof code, "WIN32_%lu", (unsigned long)error) < 0 ||
      snprintf(message, sizeof message, "%s failed: WIN32_%lu", api, (unsigned long)error) < 0) {
    throw_error(env, "ERR_JOB_ADDON", "error formatting failed");
    return;
  }
  throw_error(env, code, message);
}

/*
 * Closes a handle on an error path. The error already being reported is
 * kept; a failing close here is reported only through the return value.
 */
static BOOL close_on_error_path(HANDLE handle) {
  return CloseHandle(handle);
}

/* Reads exactly `expected` arguments; false (with a TypeError) otherwise. */
static bool get_args(napi_env env, napi_callback_info info, size_t expected, napi_value *argv) {
  napi_value slots[MAX_ARGS + 1u];
  size_t argc = MAX_ARGS + 1u;
  size_t i;
  if (napi_get_cb_info(env, info, &argc, slots, NULL, NULL) != napi_ok) {
    throw_napi(env);
    return false;
  }
  if (argc != expected) {
    throw_type_error(env, "ERR_INVALID_ARG_COUNT", "wrong number of arguments");
    return false;
  }
  for (i = 0; i < expected && i < MAX_ARGS; i++) {
    argv[i] = slots[i];
  }
  return true;
}

/* An integral JS number in [min, 0xFFFFFFFF]. */
static bool get_uint32(napi_env env, napi_value value, DWORD min, const char *what, DWORD *out) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok) {
    throw_napi(env);
    return false;
  }
  if (type != napi_number) {
    throw_type_error(env, "ERR_INVALID_ARG_TYPE", what);
    return false;
  }
  if (napi_get_value_double(env, value, &number) != napi_ok) {
    throw_napi(env);
    return false;
  }
  if (!isfinite(number) || floor(number) != number || number < (double)min ||
      number > 4294967295.0) {
    throw_type_error(env, "ERR_INVALID_ARG_VALUE", what);
    return false;
  }
  *out = (DWORD)number;
  return true;
}

/* The job behind an external of this addon; false (with an error) otherwise. */
static bool get_job(napi_env env, napi_value value, job **out) {
  napi_valuetype type;
  bool tagged = false;
  void *data = NULL;
  if (napi_typeof(env, value, &type) != napi_ok) {
    throw_napi(env);
    return false;
  }
  if (type != napi_external) {
    throw_type_error(env, "ERR_INVALID_ARG_TYPE", "job must be a job external");
    return false;
  }
  if (napi_check_object_type_tag(env, value, &JOB_TAG, &tagged) != napi_ok) {
    throw_napi(env);
    return false;
  }
  if (!tagged) {
    throw_type_error(env, "ERR_INVALID_ARG_TYPE", "job must be a job external");
    return false;
  }
  if (napi_get_value_external(env, value, &data) != napi_ok || data == NULL) {
    throw_napi(env);
    return false;
  }
  *out = (job *)data;
  return true;
}

/* A job that is still open; ERR_JOB_CLOSED otherwise. */
static bool get_open_job(napi_env env, napi_value value, job **out) {
  if (!get_job(env, value, out)) {
    return false;
  }
  if ((*out)->handle == NULL) {
    throw_error(env, "ERR_JOB_CLOSED", "job is closed");
    return false;
  }
  return true;
}

/* { creationTime: "<decimal FILETIME, 100 ns units>" } */
static napi_value creation_time_result(napi_env env, const FILETIME *creation) {
  unsigned long long value =
      ((unsigned long long)creation->dwHighDateTime << 32) | creation->dwLowDateTime;
  char digits[24];
  napi_value result;
  napi_value text;
  if (snprintf(digits, sizeof digits, "%llu", value) < 0) {
    throw_error(env, "ERR_JOB_ADDON", "creation time formatting failed");
    return NULL;
  }
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_latin1(env, digits, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_set_named_property(env, result, "creationTime", text) != napi_ok) {
    throw_napi(env);
    return NULL;
  }
  return result;
}

static void finalize_job(napi_env env, void *data, void *hint) {
  job *j = (job *)data;
  (void)env;
  (void)hint;
  if (j == NULL) {
    return;
  }
  if (j->handle != NULL) {
    /* KILL_ON_JOB_CLOSE: every process still in the job ends. Nothing can
       report a failure from a finalizer; the handle is gone either way. */
    (void)CloseHandle(j->handle);
    j->handle = NULL;
  }
  free(j);
}

/* createJob() -> external */
static napi_value create_job(napi_env env, napi_callback_info info) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  napi_value external;
  HANDLE handle;
  job *j;
  if (!get_args(env, info, 0u, NULL)) {
    return NULL;
  }
  j = (job *)malloc(sizeof *j);
  if (j == NULL) {
    throw_error(env, "ERR_JOB_NO_MEMORY", "out of memory");
    return NULL;
  }
  /* No security attributes: the handle is not inheritable, so no child
     process (the CLI included) can keep the job alive after the host. */
  handle = CreateJobObjectW(NULL, NULL);
  if (handle == NULL) {
    DWORD error = GetLastError();
    free(j);
    throw_win32(env, "CreateJobObjectW", error);
    return NULL;
  }
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits,
                               sizeof limits)) {
    DWORD error = GetLastError();
    (void)close_on_error_path(handle);
    free(j);
    throw_win32(env, "SetInformationJobObject", error);
    return NULL;
  }
  j->handle = handle;
  if (napi_create_external(env, j, finalize_job, NULL, &external) != napi_ok) {
    (void)close_on_error_path(handle);
    free(j);
    throw_napi(env);
    return NULL;
  }
  /* From here on the finalizer owns j. */
  if (napi_type_tag_object(env, external, &JOB_TAG) != napi_ok) {
    j->handle = NULL;
    (void)close_on_error_path(handle);
    throw_napi(env);
    return NULL;
  }
  return external;
}

/*
 * assignProcess(job, pid) -> { creationTime }
 *
 * The caller holds the child's own process handle (Node's ChildProcess),
 * so the pid cannot name another process here. The creation time is read
 * through the same handle that is assigned, so it belongs to the assigned
 * process.
 */
static napi_value assign_process(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  FILETIME creation;
  FILETIME exited;
  FILETIME kernel;
  FILETIME user;
  HANDLE process;
  DWORD pid;
  job *j;
  if (!get_args(env, info, 2u, argv) || !get_open_job(env, argv[0], &j) ||
      !get_uint32(env, argv[1], 1u, "pid must be an integer in [1, 4294967295]", &pid)) {
    return NULL;
  }
  process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                        FALSE, pid);
  if (process == NULL) {
    throw_win32(env, "OpenProcess", GetLastError());
    return NULL;
  }
  if (!GetProcessTimes(process, &creation, &exited, &kernel, &user)) {
    DWORD error = GetLastError();
    (void)close_on_error_path(process);
    throw_win32(env, "GetProcessTimes", error);
    return NULL;
  }
  if (!AssignProcessToJobObject(j->handle, process)) {
    DWORD error = GetLastError();
    (void)close_on_error_path(process);
    throw_win32(env, "AssignProcessToJobObject", error);
    return NULL;
  }
  if (!CloseHandle(process)) {
    throw_win32(env, "CloseHandle", GetLastError());
    return NULL;
  }
  return creation_time_result(env, &creation);
}

/* terminateJob(job, exitCode); idempotent while open. */
static napi_value terminate_job(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  DWORD exit_code;
  job *j;
  if (!get_args(env, info, 2u, argv) || !get_open_job(env, argv[0], &j) ||
      !get_uint32(env, argv[1], 0u, "exitCode must be an integer in [0, 4294967295]",
                  &exit_code)) {
    return NULL;
  }
  if (!TerminateJobObject(j->handle, exit_code)) {
    throw_win32(env, "TerminateJobObject", GetLastError());
    return NULL;
  }
  return NULL;
}

/* closeJob(job); idempotent. A failed close is never retried. */
static napi_value close_job(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  HANDLE handle;
  job *j;
  if (!get_args(env, info, 1u, argv) || !get_job(env, argv[0], &j)) {
    return NULL;
  }
  handle = j->handle;
  if (handle == NULL) {
    return NULL;
  }
  j->handle = NULL;
  if (!CloseHandle(handle)) {
    throw_win32(env, "CloseHandle", GetLastError());
    return NULL;
  }
  return NULL;
}

/* listPids(job) -> number[] (at most MAX_LISTED_PIDS entries). */
static napi_value list_pids(napi_env env, napi_callback_info info) {
  const size_t size =
      FIELD_OFFSET(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) + MAX_LISTED_PIDS * sizeof(ULONG_PTR);
  JOBOBJECT_BASIC_PROCESS_ID_LIST *list;
  napi_value argv[1];
  napi_value result = NULL;
  DWORD count;
  DWORD i;
  job *j;
  if (!get_args(env, info, 1u, argv) || !get_open_job(env, argv[0], &j)) {
    return NULL;
  }
  list = (JOBOBJECT_BASIC_PROCESS_ID_LIST *)calloc(1u, size);
  if (list == NULL) {
    throw_error(env, "ERR_JOB_NO_MEMORY", "out of memory");
    return NULL;
  }
  /* More than MAX_LISTED_PIDS processes fail with ERROR_MORE_DATA (WIN32_234). */
  if (!QueryInformationJobObject(j->handle, JobObjectBasicProcessIdList, list, (DWORD)size,
                                 NULL)) {
    DWORD error = GetLastError();
    free(list);
    throw_win32(env, "QueryInformationJobObject", error);
    return NULL;
  }
  count = list->NumberOfProcessIdsInList;
  if (count > MAX_LISTED_PIDS) {
    free(list);
    throw_error(env, "ERR_JOB_ADDON_OUTPUT", "QueryInformationJobObject returned too many pids");
    return NULL;
  }
  if (napi_create_array_with_length(env, count, &result) != napi_ok) {
    free(list);
    throw_napi(env);
    return NULL;
  }
  for (i = 0; i < count; i++) {
    ULONG_PTR pid = list->ProcessIdList[i];
    napi_value element;
    if (pid == 0u || pid > 0xFFFFFFFFu) {
      free(list);
      throw_error(env, "ERR_JOB_ADDON_OUTPUT", "QueryInformationJobObject returned an invalid pid");
      return NULL;
    }
    if (napi_create_uint32(env, (uint32_t)pid, &element) != napi_ok ||
        napi_set_element(env, result, i, element) != napi_ok) {
      free(list);
      throw_napi(env);
      return NULL;
    }
  }
  free(list);
  return result;
}

/* processTimes(pid) -> { creationTime } */
static napi_value process_times(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  FILETIME creation;
  FILETIME exited;
  FILETIME kernel;
  FILETIME user;
  HANDLE process;
  DWORD pid;
  if (!get_args(env, info, 1u, argv) ||
      !get_uint32(env, argv[0], 1u, "pid must be an integer in [1, 4294967295]", &pid)) {
    return NULL;
  }
  process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == NULL) {
    throw_win32(env, "OpenProcess", GetLastError());
    return NULL;
  }
  if (!GetProcessTimes(process, &creation, &exited, &kernel, &user)) {
    DWORD error = GetLastError();
    (void)close_on_error_path(process);
    throw_win32(env, "GetProcessTimes", error);
    return NULL;
  }
  if (!CloseHandle(process)) {
    throw_win32(env, "CloseHandle", GetLastError());
    return NULL;
  }
  return creation_time_result(env, &creation);
}

NAPI_MODULE_INIT() {
  napi_value version;
  napi_property_descriptor properties[7];
  if (napi_create_string_latin1(env, HUDHUD_WIN32_JOB_VERSION, NAPI_AUTO_LENGTH, &version) !=
      napi_ok) {
    throw_napi(env);
    return NULL;
  }
  ZeroMemory(properties, sizeof properties);
  properties[0].utf8name = "createJob";
  properties[0].method = create_job;
  properties[1].utf8name = "assignProcess";
  properties[1].method = assign_process;
  properties[2].utf8name = "terminateJob";
  properties[2].method = terminate_job;
  properties[3].utf8name = "closeJob";
  properties[3].method = close_job;
  properties[4].utf8name = "listPids";
  properties[4].method = list_pids;
  properties[5].utf8name = "processTimes";
  properties[5].method = process_times;
  properties[6].utf8name = "version";
  properties[6].value = version;
  for (size_t i = 0; i < sizeof properties / sizeof properties[0]; i++) {
    properties[i].attributes = napi_enumerable;
  }
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) !=
      napi_ok) {
    throw_napi(env);
    return NULL;
  }
  return exports;
}

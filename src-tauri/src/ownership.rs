// A job object kills this application's Windows subprocess trees if the host
// crashes. Linux process groups are separately recorded in SQLite.
#[cfg(windows)]
pub struct Job(usize);
#[cfg(windows)]
impl Job {
    pub fn new() -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                CloseHandle(handle);
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Self(handle as usize))
        }
    }
    pub fn attach(&self, child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            if windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                self.0 as _,
                child.as_raw_handle() as _,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    }
    pub fn attach_pid(&self, pid: u32) {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                AssignProcessToJobObject(self.0 as _, handle);
                CloseHandle(handle);
            }
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}
#[cfg(not(windows))]
pub struct Job;
#[cfg(not(windows))]
impl Job {
    pub fn new() -> Result<Self, String> {
        Ok(Self)
    }
    pub fn attach(&self, _: &std::process::Child) -> Result<(), String> {
        Ok(())
    }
    pub fn attach_pid(&self, _: u32) {}
}
